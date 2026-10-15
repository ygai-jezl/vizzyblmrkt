import { NextResponse } from "next/server";
import { agentBrandMap, brandMapAgentGate } from "@/lib/brandMap/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the brand map (what is decided, what waits, and with the pages switch on what
 * is answered), so it can talk about it and suggest changes. Auth: the signed canvas
 * capability token in `X-Canvas-Context`; gated by BRAND_MAP_CHAT_ENABLED.
 */
export async function GET(req: Request) {
  const gate = brandMapAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentBrandMap(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
