import { NextResponse } from "next/server";
import { agentEmailStyle, emailStyleAgentGate } from "@/lib/email/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the Email style (saved, pending suggestion and what the brand kit would
 * pick), so it can answer "what's my email style?" and suggest one. No person's data.
 * Auth: the signed canvas capability token in `X-Canvas-Context`; gated by the Email
 * style flag.
 */
export async function GET(req: Request) {
  const gate = emailStyleAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentEmailStyle(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
