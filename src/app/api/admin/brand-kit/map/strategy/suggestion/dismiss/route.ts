import { NextResponse } from "next/server";
import { notNowFromRequest, overLimit, SUGGEST_LIMIT, suggestAdmin } from "@/lib/brandStrategy/adminApi";
import { forgetReviewCount } from "@/lib/review/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Not now on the month's strategy suggestion (STRATEGY_SUGGEST_ENABLED), for your own brand: origin,
 * the switch, sign-in, admins only, a brand's own limit, then the reason. The brand comes from the
 * session only.
 */
export async function POST(req: Request) {
  const g = await suggestAdmin(req);
  if (!g.ok) return g.response;
  if (await overLimit(g.ctx, SUGGEST_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const res = await notNowFromRequest(g.ctx, await req.json().catch(() => null));
  if (res.ok) forgetReviewCount(g.ctx.tenantId);
  return res;
}
