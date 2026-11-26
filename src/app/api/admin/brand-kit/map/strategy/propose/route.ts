import { NextResponse } from "next/server";
import { overLimit, PROPOSE_LIMIT, proposeFromRequest, strategyAdmin } from "@/lib/brandStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Propose with Vizzy: one model call drafts the strategy. Admins only, a few an hour per brand. */
export async function POST(req: Request) {
  const g = await strategyAdmin(req);
  if (!g.ok) return g.response;
  if (await overLimit(g.ctx, PROPOSE_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  return proposeFromRequest(g.ctx);
}
