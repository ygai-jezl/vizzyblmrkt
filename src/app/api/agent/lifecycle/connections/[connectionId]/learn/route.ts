import { NextResponse } from "next/server";
import { agentGate } from "@/lib/lifecycle/agentApi";
import { agentGetRepoAnalysis, agentStartRepoAnalysis } from "@/lib/connect/agentRepoAnalysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectionId: string }> };

/** For Vizzy: the latest "Learn from repo" result for this product, summarised (no code excerpts). */
export async function GET(req: Request, { params }: Params) {
  const gate = agentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentGetRepoAnalysis(gate.ctx, (await params).connectionId);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

/** For Vizzy: start a read-only analysis ({ repos: [{ url, ref? }] }). Accepting stays with a person. */
export async function POST(req: Request, { params }: Params) {
  const gate = agentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  // Same rule as the UI: only admins start an analysis (it reads the account's connected repos).
  if (gate.ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const r = await agentStartRepoAnalysis(gate.ctx, (await params).connectionId, await req.json().catch(() => undefined));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
