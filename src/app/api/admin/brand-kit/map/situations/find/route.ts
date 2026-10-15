import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapResearchEnabled, isBrandMapSituationsEnabled } from "@/lib/brandMap/flags";
import { findSituationsFromRequest } from "@/lib/brandMap/situationsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Find buying situations", step 1 (a step of a "situations" run): one search-grounded call
 * that proposes the situations people are in, about a minute. Admin-only. Nothing is on the
 * map until a person adds it.
 */
export async function POST(req: Request) {
  const g = await brandMapAdmin(req, { on: () => isBrandMapSituationsEnabled() && isBrandMapResearchEnabled(), offError: "situations_disabled" });
  if (!g.ok) return g.response;
  return findSituationsFromRequest(g.ctx, await req.json().catch(() => null));
}
