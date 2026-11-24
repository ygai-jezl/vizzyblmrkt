import { NextResponse } from "next/server";
import { connectorsAgentGate, SUGGESTIONS_GATE } from "@/lib/connectors/agentGate";
import { agentNumberSuggestions } from "@/lib/connectors/signals/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's get_number_suggestions: the open suggestions from collected numbers, read only, from
 * connections both members and Vizzy may read, every number with its meaning. Body: { rule?, limit? }.
 * Needs CONNECTOR_SIGNALS_ENABLED (else 503), and counts in the connectors_numbers rate limit.
 */
export async function POST(req: Request) {
  const gate = await connectorsAgentGate(req, SUGGESTIONS_GATE);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  // No body asks for every open suggestion; a body that isn't JSON is refused.
  const text = await req.text().catch(() => "");
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
  }
  const r = await agentNumberSuggestions(gate.ctx, gate.actor, raw);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
