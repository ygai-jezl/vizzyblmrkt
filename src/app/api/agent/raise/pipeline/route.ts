import { NextResponse } from "next/server";
import { agentRaisePipeline, raiseAgentGate } from "@/lib/raise/pipeline/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's get_raise_pipeline (RAISE_PIPELINE_ENABLED): the brand's investor or funding board as
 * counts by stage and reason, and how many are quiet or past their next step date. Never a name.
 * Read only. Auth: the signed canvas token in `X-Canvas-Context`, which names the brand and the
 * member asking.
 */
export async function GET(req: Request) {
  const gate = await raiseAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status, headers: { "cache-control": "no-store" } });
  const r = await agentRaisePipeline(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
