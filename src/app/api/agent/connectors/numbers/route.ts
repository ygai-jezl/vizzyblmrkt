import { NextResponse } from "next/server";
import { connectorsAgentGate, NUMBERS_GATE } from "@/lib/connectors/agentGate";
import { agentCollectedNumbers } from "@/lib/connectors/numbers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's get_connected_numbers: a connection's collected numbers for a period, read from the
 * brand's metric snapshots by id, never from the provider, every number with its meaning. Body:
 * { connectionId, stream, period | from and to, by?, limit?, page? }. Needs CONNECTORS_CHAT_ENABLED
 * and CONNECTORS_COLLECT_ENABLED (else 503), and counts in its own rate limit, connectors_numbers.
 */
export async function POST(req: Request) {
  const gate = await connectorsAgentGate(req, NUMBERS_GATE);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentCollectedNumbers(gate.ctx, gate.actor, await req.json().catch(() => undefined));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
