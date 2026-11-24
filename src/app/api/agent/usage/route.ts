import { NextResponse } from "next/server";
import { agentUsage, usageAgentGate } from "@/lib/plans/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy's get_usage: this brand's use of paid resources this month, with limits. Gated by USAGE_METER_ENABLED. */
export async function GET(req: Request) {
  const gate = await usageAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentUsage(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
