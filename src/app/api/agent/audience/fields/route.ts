import { NextResponse } from "next/server";
import { agentFieldList, vizzyFieldsAgentGate } from "@/lib/audience/agentFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the brand's People fields it may read (select, multi select, status, checkbox, number,
 * currency and date, and text fields an admin let it read while AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED
 * is on), with their options and no values. Auth: the signed canvas token in `X-Canvas-Context`;
 * gated by AUDIENCE_VIZZY_FIELDS_ENABLED.
 */
export async function GET(req: Request) {
  const gate = vizzyFieldsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentFieldList(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
