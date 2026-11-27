import { NextResponse } from "next/server";
import { agentRaiseDocs, raiseAgentGate } from "@/lib/raise/docs/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's get_raise_doc: the brand's decks, read only (VIZZY_RAISE_ENABLED). `docId` names one
 * deck; without it, the brand's only deck, or the list. The brand comes from the signed canvas
 * token in `X-Canvas-Context`, never from the query.
 */
export async function GET(req: Request) {
  const gate = await raiseAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status, headers: { "cache-control": "no-store" } });
  const docId = new URL(req.url).searchParams.get("docId")?.trim() || null;
  const r = await agentRaiseDocs(gate.ctx, docId);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
