import { NextResponse } from "next/server";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { agentInsightsSummary, insightsAgentGate } from "@/lib/insights/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the Insights numbers as aggregates, so it can answer "what drove
 * signups this week?" from real figures. No person's data. Auth: the signed canvas
 * capability token in `X-Canvas-Context`; gated by the Insights hub flag.
 */
export async function GET(req: Request) {
  const gate = insightsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentInsightsSummary(gate.ctx, {
    lifecycle: isLifecycleEnabled(),
    invites: isInvitesUiEnabled() && isInvitesEnabled(),
  });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
