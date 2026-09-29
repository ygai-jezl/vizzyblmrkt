import { NextResponse } from "next/server";
import { agentJourneyStyle, journeyStyleAgentGate } from "@/lib/lifecycle/journeyStyleAgentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: one lifecycle journey's own Email style (`?journeyId=`, or a launch's welcome
 * journey by `?campaignId=`): the brand's style, the draft's and the live one, and whether the
 * asker may set it. No person's data. Auth: the signed canvas capability token in
 * `X-Canvas-Context`; gated by the Email style and journey style flags.
 */
export async function GET(req: Request) {
  const gate = journeyStyleAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const params = new URL(req.url).searchParams;
  const r = await agentJourneyStyle(gate.ctx, { journeyId: params.get("journeyId"), campaignId: params.get("campaignId") });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
