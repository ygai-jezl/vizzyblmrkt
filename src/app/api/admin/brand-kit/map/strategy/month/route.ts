import { NextResponse } from "next/server";
import { MONTH_LIMIT, overLimit, resultsAdmin, resultsReader } from "@/lib/brandStrategy/adminApi";
import { monthsFromRequest, runMonthFromRequest } from "@/lib/brandStrategy/monthView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How it went (STRATEGY_RESULTS_ENABLED): the months kept, and what can be measured now. Any member reads it. */
export async function GET(req: Request) {
  const g = await resultsReader(req);
  if (!g.ok) return g.response;
  return monthsFromRequest(g.ctx);
}

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
