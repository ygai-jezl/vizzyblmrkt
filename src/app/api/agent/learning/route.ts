import { NextResponse } from "next/server";
import { agentLearning, learningAgentGate, parseLearningQuery } from "@/lib/loops/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's get_learning: this brand's own learning by kind, read only (`?kinds=` by key or
 * label, `?all=1` for every kind, `?days=` from 7 to 182, 90 by default). Gated by LOOPS_ENABLED;
 * the brand is the signed token's, never one the query names.
 */
export async function GET(req: Request) {
  const gate = await learningAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentLearning(gate.ctx, parseLearningQuery(new URL(req.url).searchParams));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
