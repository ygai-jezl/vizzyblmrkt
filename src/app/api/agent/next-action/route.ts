import { NextResponse } from "next/server";
import { agentReadNextAction, nextActionAgentGate } from "@/lib/nextAction/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: Home's Your next action, read only. The card on Home now, each step with what its
 * button does and what became of it, and the newest outcomes of earlier steps (admins). Auth: the
 * signed canvas capability token in `X-Canvas-Context` (the brand and role come from it); gated by
 * NEXT_ACTION_CARD_ENABLED.
 */
export async function GET(req: Request) {
  const gate = nextActionAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentReadNextAction(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
