import { NextResponse } from "next/server";
import { agentContentPlan, contentAgentGate } from "@/lib/content/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy's content_ops agent: one plan's pieces, so it can rewrite the right ones. Auth: the canvas token. */
export async function GET(req: Request, { params }: { params: Promise<{ workspaceId: string; planId: string }> }) {
  const gate = contentAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const { workspaceId, planId } = await params;
  const r = await agentContentPlan(gate.ctx, workspaceId, planId);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
