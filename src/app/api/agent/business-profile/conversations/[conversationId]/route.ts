import { NextResponse } from "next/server";
import { agentReadConversation, onboardingAgentGate } from "@/lib/onboarding/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ conversationId: string }> };

/**
 * For Vizzy: one kept conversation about the business, whole (admins only). Auth: the signed
 * canvas capability token in `X-Canvas-Context`; gated by ONBOARDING_ENABLED. Another brand's id
 * is not found.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const gate = onboardingAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const { conversationId } = await params;
  const r = await agentReadConversation(gate.ctx, conversationId);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
