import { NextResponse } from "next/server";
import { agentSettingsHistory, historyAgentGate } from "@/lib/settings/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's get_settings_history: the brand's Settings › History, read only (`?kind=`, `?subject=`,
 * `?rev=` with a subject for one version whole, `?cursor=`). Gated by SETTINGS_HISTORY_ENABLED; the
 * brand is the signed token's.
 */
export async function GET(req: Request) {
  const gate = await historyAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const url = new URL(req.url);
  const p = (k: string) => url.searchParams.get(k);
  const r = await agentSettingsHistory(gate.ctx, { kind: p("kind"), subject: p("subject"), rev: p("rev"), cursor: p("cursor") });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
