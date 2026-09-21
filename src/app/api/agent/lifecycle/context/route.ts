import { NextResponse } from "next/server";
import { agentGate, agentLifecycleContext } from "@/lib/lifecycle/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's lifecycle_ops agent: the tenant's connected products (catalogs +
 * aggregate onboarding stats), journeys, verified sending domains and
 * workspaces. Never individual users or email addresses. Auth: the signed
 * canvas capability token in `X-Canvas-Context`.
 */
export async function GET(req: Request) {
  const gate = agentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentLifecycleContext(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
