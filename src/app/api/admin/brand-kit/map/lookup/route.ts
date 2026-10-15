import { NextResponse } from "next/server";
import { isRateLimited } from "@/lib/tenant";
import { brandMapAdmin, lookupFromRequest, LOOKUP_LIMIT } from "@/lib/brandMap/adminApi";
import { isBrandMapWikidataEnabled } from "@/lib/brandMap/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Identifier candidates for one brand map name, from Wikidata's public API (Brand › Brand
 * map › Find). Admin-only and rate-limited; sends only the name; stores nothing.
 */
export async function POST(req: Request) {
  const g = await brandMapAdmin(req, { on: isBrandMapWikidataEnabled, offError: "lookup_disabled" });
  if (!g.ok) return g.response;
  if (await isRateLimited(`tenant:${g.ctx.tenantId}`, LOOKUP_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  return lookupFromRequest(g.ctx, await req.json().catch(() => null));
}
