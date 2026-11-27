import { NextResponse } from "next/server";
import { FIND_LIMIT, finderAdmin, findFromRequest, joinedReader, overLimit } from "@/lib/brandStrategy/adminApi";
import { competitorsFromRequest } from "@/lib/brandStrategy/competitorsView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the watched competitors write, set against the strategy (STRATEGY_COMPETITORS_ENABLED). Any member reads it. */
export async function GET(req: Request) {
  const g = await joinedReader(req);
  if (!g.ok) return g.response;
  return competitorsFromRequest(g.ctx);
}

/** Find competitors (COMPETITOR_FINDER_ENABLED), quick or full. Admins only, a few an hour per brand. */
export async function POST(req: Request) {
  const g = await finderAdmin(req);
  if (!g.ok) return g.response;
  if (await overLimit(g.ctx, FIND_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return findFromRequest(g.ctx, await req.json().catch(() => null));
}
