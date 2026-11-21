import { NextResponse } from "next/server";
import { agentFieldList, vizzyFieldsAgentGate } from "@/lib/audience/agentFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the brand's People fields of the seven types it may read (select, multi select,
 * status, checkbox, number, currency and date), with their options and no values. Auth: the
 * signed canvas token in `X-Canvas-Context`; gated by AUDIENCE_VIZZY_FIELDS_ENABLED.
 */
export async function GET(req: Request) {
  const gate = vizzyFieldsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentFieldList(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
