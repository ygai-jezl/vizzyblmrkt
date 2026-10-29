import { NextResponse } from "next/server";
import { agentAudienceCounts, audienceAgentGate } from "@/lib/audience/agentCounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: how many people the brand has, by launch, by product and stage, and how
 * many it can email. Counts only. Auth: the signed canvas token in `X-Canvas-Context`;
 * gated by AUDIENCE_ONE_VIEW_ENABLED.
 */
export async function GET(req: Request) {
  const gate = audienceAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentAudienceCounts(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
