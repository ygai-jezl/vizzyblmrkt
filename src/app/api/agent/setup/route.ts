import { NextResponse } from "next/server";
import { agentSetupStatus, setupAgentGate } from "@/lib/help/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy: the brand's setup steps, done and to do, with the help page for each. */
export async function GET(req: Request) {
  const gate = setupAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentSetupStatus(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
