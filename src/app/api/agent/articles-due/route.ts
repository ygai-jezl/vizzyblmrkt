import { NextResponse } from "next/server";
import { agentArticlesDue, articlesDueAgentGate } from "@/lib/content/blog/freshnessAgentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Vizzy's list_articles_due: this brand's live articles due a refresh, with why. Gated by BLOG_FRESHNESS_ENABLED. */
export async function GET(req: Request) {
  const gate = await articlesDueAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentArticlesDue(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
