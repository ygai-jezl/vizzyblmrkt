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
 * How it went by hand, for your own brand (STRATEGY_RESULTS_ENABLED): add up last month when it is due
 * and not kept, or with {"preview": true} see this month so far without keeping it. Admins only, a
 * few an hour.
 */
export async function POST(req: Request) {
  const g = await resultsAdmin(req);
  if (!g.ok) return g.response;
  const text = await req.text().catch(() => "");
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
  }
  if (await overLimit(g.ctx, MONTH_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return runMonthFromRequest(g.ctx, body);
}
