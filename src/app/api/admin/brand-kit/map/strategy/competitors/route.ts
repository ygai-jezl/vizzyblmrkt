import { NextResponse } from "next/server";
import { FIND_LIMIT, finderAdmin, findFromRequest, overLimit } from "@/lib/brandStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Find competitors (COMPETITOR_FINDER_ENABLED), quick or full. Admins only, a few an hour per brand. */
export async function POST(req: Request) {
  const g = await finderAdmin(req);
  if (!g.ok) return g.response;
  if (await overLimit(g.ctx, FIND_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return findFromRequest(g.ctx, await req.json().catch(() => null));
}
