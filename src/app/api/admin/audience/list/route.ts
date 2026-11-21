import { NextResponse } from "next/server";
import { oneViewAdmin } from "@/lib/audience/admin";
import { filterFieldIds, isFilterTag, isPeopleCursor, isPeopleTag, listPeople } from "@/lib/audience/peopleList";
import { isFieldFiltersEnabled } from "@/lib/audience/peopleFlags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Audience → People (AUDIENCE_ONE_VIEW_ENABLED): one page of everyone in a group.
 * `?show=` a group (default everyone), `&email=1` only those we can email, `&q=` search
 * everyone, `&cursor=` the next page. With AUDIENCE_FIELD_FILTERS_ENABLED a group can also be a
 * field value or a product group, and each row carries its values for the fields it can filter by.
 */
export async function GET(req: Request) {
  const gate = await oneViewAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const tag = url.searchParams.get("show") || "all";
  const cursor = url.searchParams.get("cursor");
  const filters = isFieldFiltersEnabled();
  if (!(isPeopleTag(tag) || (filters && isFilterTag(tag))) || (cursor !== null && !isPeopleCursor(cursor))) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const result = await listPeople(
    gate.ctx,
    {
      tag,
      canEmail: url.searchParams.get("email") === "1",
      q: (url.searchParams.get("q") ?? "").slice(0, 200),
      cursor,
    },
    undefined,
    filters ? { fieldIds: await filterFieldIds(gate.ctx) } : {},
  );
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
