import { NextResponse } from "next/server";
import { oneViewAdmin } from "@/lib/audience/admin";
import { isPersonId } from "@/lib/audience/paths";
import { loadWholePerson } from "@/lib/audience/wholePerson";
import { isFieldFiltersEnabled, isFieldsEnabled } from "@/lib/audience/peopleFlags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One person, whole (AUDIENCE_ONE_VIEW_ENABLED): their launches, products and launch emails, and
 * with AUDIENCE_FIELDS_ENABLED their field values, fields from elsewhere and voice chats.
 */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await oneViewAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  const person = isPersonId(personId) ? await loadWholePerson(gate.ctx, personId, undefined, { fields: isFieldsEnabled(), groups: isFieldFiltersEnabled() }) : null;
  if (!person) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ person }, { headers: { "cache-control": "no-store" } });
}
