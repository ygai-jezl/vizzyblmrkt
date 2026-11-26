import { NextResponse } from "next/server";
import { makeFromRequest, overLimit, planAdmin } from "@/lib/contentStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Make the plan: a new draft from the brand map and the approved strategy. Admins only, a few an hour per brand. */
export async function POST(req: Request) {
  const g = await planAdmin(req);
  if (!g.ok) return g.response;
  if (await overLimit(g.ctx)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return makeFromRequest(g.ctx);
}
