import { NextResponse } from "next/server";
import { agentContentStrategy, planAgentGate } from "@/lib/contentStrategy/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy's get_content_strategy: the brand's approved content plan, read only. Gated by CONTENT_STRATEGY_CHAT_ENABLED. */
export async function GET(req: Request) {
  const gate = await planAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentContentStrategy(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
