import { NextResponse } from "next/server";
import { agentBrandMap, brandMapAgentGate } from "@/lib/brandMap/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the brand map (what is decided, what waits, and with the pages switch on what
 * is answered), so it can talk about it and suggest changes. A map at any size is read a
 * part at a time: `?find=<words>`, `?subject=<id>`, `?import=<id or latest>`, or a summary.
 * Auth: the signed canvas capability token in `X-Canvas-Context`; gated by
 * BRAND_MAP_CHAT_ENABLED.
 */
export async function GET(req: Request) {
  const gate = brandMapAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const q = new URL(req.url).searchParams;
  const r = await agentBrandMap(gate.ctx, undefined, { find: q.get("find"), subject: q.get("subject"), importId: q.get("import") });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
