import { NextResponse } from "next/server";
import { agentLiveRead } from "@/lib/connectors/agentApi";
import { connectorsAgentGate } from "@/lib/connectors/agentGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's read_connected_live: one capped live read of a connection Vizzy may read, every
 * number with its meaning. Body: { connectionId, stream, from, to, by?, limit? }. Gated by
 * CONNECTORS_CHAT_ENABLED.
 */
export async function POST(req: Request) {
  const gate = await connectorsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentLiveRead(gate.ctx, gate.actor, await req.json().catch(() => undefined));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
