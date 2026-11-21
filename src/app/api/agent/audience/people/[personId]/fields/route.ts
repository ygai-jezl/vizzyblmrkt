import { NextResponse } from "next/server";
import { agentPersonFields, vizzyFieldsAgentGate } from "@/lib/audience/agentFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: one person's values of the fields it may read (vizzyReadsField), by our id for them,
 * with the fields that already have a suggestion waiting. Never their name, address, or an email,
 * phone, link or team member value; a text value only for a field an admin let Vizzy read, while
 * AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED is on, scrubbed and cut to 500 characters. Auth: the signed
 * canvas token; gated by AUDIENCE_VIZZY_FIELDS_ENABLED.
 */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = vizzyFieldsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const { personId } = await params;
  const r = await agentPersonFields(gate.ctx, personId);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
