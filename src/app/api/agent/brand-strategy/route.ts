import { NextResponse } from "next/server";
import { agentBrandStrategy, strategyAgentGate } from "@/lib/brandStrategy/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy's get_brand_strategy: the brand's approved strategy, read only. Gated by BRAND_STRATEGY_CHAT_ENABLED. */
export async function GET(req: Request) {
  const gate = await strategyAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentBrandStrategy(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
