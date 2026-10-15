import { NextResponse } from "next/server";
import { isRateLimited } from "@/lib/tenant";
import { brandMapAdmin, researchFromRequest, RESEARCH_LIMIT } from "@/lib/brandMap/adminApi";
import { isBrandMapResearchEnabled } from "@/lib/brandMap/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Research the brand map (Brand › Brand map › Research my brand). Admin-only, rate-limited
 * per brand, about a minute. Files what it finds as suggestions; nothing decided changes.
 */
export async function POST(req: Request) {
  const g = await brandMapAdmin(req, { on: isBrandMapResearchEnabled, offError: "research_disabled" });
  if (!g.ok) return g.response;
  if (await isRateLimited(`tenant:${g.ctx.tenantId}`, RESEARCH_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  return researchFromRequest(g.ctx);
}
