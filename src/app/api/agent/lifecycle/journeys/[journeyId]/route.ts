import { NextResponse } from "next/server";
import { agentGate, agentLifecycleJourney } from "@/lib/lifecycle/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy: one journey's DRAFT (graph, pools, settings) and its issues, so chat edits work in context. */
export async function GET(req: Request, { params }: { params: Promise<{ journeyId: string }> }) {
  const gate = agentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentLifecycleJourney(gate.ctx, (await params).journeyId);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
