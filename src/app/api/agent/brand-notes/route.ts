import { NextResponse } from "next/server";
import { agentReadNotes, agentSuggestNotes, brandNotesAgentGate } from "@/lib/brandNotes/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the brand's notes on What we've seen (a summary and the newest, or `?find=<words>`
 * for the nearest), and filing new ones as suggestions an admin keeps. Auth: the signed canvas
 * capability token in `X-Canvas-Context`; gated by BRAND_NOTES_CHAT_ENABLED.
 */
export async function GET(req: Request) {
  const gate = brandNotesAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentReadNotes(gate.ctx, { find: new URL(req.url).searchParams.get("find") });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = brandNotesAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentSuggestNotes(gate.ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
