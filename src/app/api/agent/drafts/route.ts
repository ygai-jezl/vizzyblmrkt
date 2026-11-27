import { NextResponse } from "next/server";
import { agentDrafts, draftsAgentGate } from "@/lib/agentRecord/agentDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's get_drafts: what became of the drafts Vizzy, research and the autopilot made, from
 * the agent record (`?kind=`, `?days=`). Gated by AGENT_RECORD_ENABLED; the brand is the signed
 * token's; 6 a minute and 60 an hour per brand.
 */
export async function GET(req: Request) {
  const gate = await draftsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const url = new URL(req.url);
  const r = await agentDrafts(gate.ctx, { kind: url.searchParams.get("kind"), days: url.searchParams.get("days") });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
