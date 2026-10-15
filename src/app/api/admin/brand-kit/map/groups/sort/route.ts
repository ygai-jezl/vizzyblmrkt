import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapResearchEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { sortGroupsFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One batch of "Sort into groups" (the map at any size), as a step of a "groups" run: new
 * groups are proposed, and subjects only get a suggested group, for a person to accept.
 * Admin-only.
 */
export async function POST(req: Request) {
  const g = await brandMapAdmin(req, { on: () => isBrandMapScaleEnabled() && isBrandMapResearchEnabled(), offError: "research_disabled" });
  if (!g.ok) return g.response;
  return sortGroupsFromRequest(g.ctx, await req.json().catch(() => null));
}
