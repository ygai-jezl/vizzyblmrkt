import { NextResponse } from "next/server";
import { agentViewCounts, viewsAgentGate } from "@/lib/views/agentViews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's get_view_counts (CRM_VIEWS_ENABLED): the brand's saved views on People, and counts for
 * up to 3 named with `?count=` (a view's name or id, repeated). Read only. Auth: the signed canvas
 * token in `X-Canvas-Context`, which names the brand and the member asking.
 */
export async function GET(req: Request) {
  const gate = await viewsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status, headers: { "cache-control": "no-store" } });
  // Each `count` value, in order (URLSearchParams' getAll reads like a Firestore call to the lint rule).
  const asked = [...new URL(req.url).searchParams.entries()]
    .filter(([k]) => k === "count")
    .slice(0, 10)
    .map(([, c]) => c.slice(0, 100));
  const r = await agentViewCounts(gate.ctx, asked);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
