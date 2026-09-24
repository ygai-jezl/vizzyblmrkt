import { NextResponse } from "next/server";
import { agentContentContext, contentAgentGate } from "@/lib/content/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's content_ops agent: the brand's programmes, their templates and
 * recent plans, and the values an intake accepts. Brand content only — never a
 * person's data. Auth: the signed canvas capability token in `X-Canvas-Context`.
 */
export async function GET(req: Request) {
  const gate = contentAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const workspaceId = new URL(req.url).searchParams.get("workspaceId")?.slice(0, 200) || null;
  const r = await agentContentContext(gate.ctx, { workspaceId });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
