import { NextResponse } from "next/server";
import { agentHelpPage, setupAgentGate } from "@/lib/help/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy: one help page as Markdown (`?page=email-sending`). */
export async function GET(req: Request) {
  const gate = setupAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = agentHelpPage(new URL(req.url).searchParams.get("page") ?? "");
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
