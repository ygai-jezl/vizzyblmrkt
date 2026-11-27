import { NextResponse } from "next/server";
import { MONTH_LIMIT, overLimit, resultsAdmin } from "@/lib/brandStrategy/adminApi";
import { runMonthFromRequest } from "@/lib/brandStrategy/monthView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add up last month's How it went for your own brand now (STRATEGY_RESULTS_ENABLED), in place of the
 * one kept: the dev check's way to run the monthly look by hand. Admins only, a few an hour.
 */
export async function POST(req: Request) {
  const g = await resultsAdmin(req);
  if (!g.ok) return g.response;
  if (await overLimit(g.ctx, MONTH_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return runMonthFromRequest(g.ctx);
}
