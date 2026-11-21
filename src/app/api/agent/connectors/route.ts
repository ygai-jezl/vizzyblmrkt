import { NextResponse } from "next/server";
import { agentConnections } from "@/lib/connectors/agentApi";
import { connectorsAgentGate } from "@/lib/connectors/agentGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's list_connections: the brand's connections Vizzy may read, their health and what
 * each gives, with the meaning of every number. Gated by CONNECTORS_CHAT_ENABLED.
 */
export async function GET(req: Request) {
  const gate = await connectorsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentConnections(gate.ctx, gate.actor);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
