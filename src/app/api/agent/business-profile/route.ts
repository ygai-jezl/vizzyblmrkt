import { NextResponse } from "next/server";
import { agentReadProfile, agentSuggestFact, onboardingAgentGate } from "@/lib/onboarding/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the brand's profile (`?view=chat` for the short one it reads before every chat, else
 * the whole of it), and suggesting something new it heard, which waits for an admin's Keep in
 * Settings, About your business. Auth: the signed canvas capability token in `X-Canvas-Context`
 * (the brand and role come from it); gated by ONBOARDING_ENABLED.
 */
export async function GET(req: Request) {
  const gate = onboardingAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const view = new URL(req.url).searchParams.get("view") === "chat" ? "chat" : "full";
  const r = await agentReadProfile(gate.ctx, { view });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = onboardingAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentSuggestFact(gate.ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
