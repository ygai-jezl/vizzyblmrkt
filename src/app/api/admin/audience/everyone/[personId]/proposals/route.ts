import { NextResponse } from "next/server";
import { z } from "zod";
import { vizzyFieldsAdmin } from "@/lib/audience/admin";
import { decideFieldSuggestion, suggestionsForPage, type DecideError } from "@/lib/audience/fieldSuggestions";
import { isContactPersonId } from "@/lib/ontology/person";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * Vizzy's suggestions for one person's fields (AUDIENCE_VIZZY_FIELDS_ENABLED). GET: the open ones
 * and those confirmed in the last 7 days, for anyone on the team. POST `{ id, rev, decision }`
 * with confirm, dismiss or undo: admins only. Confirm and undo go through the one field writer;
 * each step records its agent.* event.
 */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await vizzyFieldsAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  if (!isContactPersonId(personId)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  return NextResponse.json(await suggestionsForPage(gate.ctx, personId), { headers: noStore });
}

const Body = z
  .object({
    id: z.string().max(64),
    rev: z.number().int().min(1),
    decision: z.enum(["confirm", "dismiss", "undo"]),
  })
  .strict();

const STATUS: Record<DecideError, number> = {
  not_found: 404,
  stale: 409,
  changed: 409,
  edited_since: 409,
  too_old: 409,
  too_large: 400,
  no_user: 403,
};

export async function POST(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await vizzyFieldsAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  const r = await decideFieldSuggestion(gate.ctx, personId, parsed.data);
  if (!r.ok) {
    const error = r.error === "no_user" ? "forbidden" : r.error;
    return NextResponse.json({ error, ...(r.fieldId ? { fieldId: r.fieldId } : {}) }, { status: STATUS[r.error], headers: noStore });
  }
  return NextResponse.json({ state: r.state }, { headers: noStore });
}
