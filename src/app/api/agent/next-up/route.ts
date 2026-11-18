import { NextResponse } from "next/server";
import { agentNextUp, nextUpAgentGate } from "@/lib/autopilot/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy's get_next_up: the brand's three best next articles with why. Gated by BRAND_MAP_NEXT_UP_ENABLED. */
export async function GET(req: Request) {
  const gate = await nextUpAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentNextUp(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
