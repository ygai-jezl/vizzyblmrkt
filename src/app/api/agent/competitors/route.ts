import { NextResponse } from "next/server";
import { agentReadCompetitors, competitorsAgentGate } from "@/lib/competitors/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the competitors a brand watches, how each site is built and what changed
 * (`?name=<words>` for one). Read only. Auth: the signed canvas capability token in
 * `X-Canvas-Context`; gated by COMPETITORS_CHAT_ENABLED and the brand's access.
 */
export async function GET(req: Request) {
  const gate = await competitorsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentReadCompetitors(gate.ctx, { name: new URL(req.url).searchParams.get("name") });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
