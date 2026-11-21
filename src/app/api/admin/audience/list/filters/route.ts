import { NextResponse } from "next/server";
import { oneViewAdmin } from "@/lib/audience/admin";
import { fieldOptionCounts, peopleFilters } from "@/lib/audience/peopleList";
import { isFieldFiltersEnabled } from "@/lib/audience/peopleFlags";
import { isFieldId } from "@/lib/types/recordField";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Audience → People (AUDIENCE_ONE_VIEW_ENABLED): the groups the list can show, with how many are
 * in each. With AUDIENCE_FIELD_FILTERS_ENABLED it adds the fields the list can filter by, and
 * `?field=<id>` counts that one field's options, when its menu opens.
 */
export async function GET(req: Request) {
  const gate = await oneViewAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const noStore = { "cache-control": "no-store" };
  const filters = isFieldFiltersEnabled();
  const field = new URL(req.url).searchParams.get("field");
  if (field !== null) {
    if (!filters || !isFieldId(field)) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
    const counts = await fieldOptionCounts(gate.ctx, field);
    if (!counts) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
    return NextResponse.json({ counts }, { headers: noStore });
  }
  return NextResponse.json(await peopleFilters(gate.ctx, undefined, { fields: filters }), { headers: noStore });
}
