import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapResearchEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { startRunFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a research run on the map at any size ("Sort into groups"; later, buying situations
 * and research from a PDF): it uses one research allowance, then each step carries the run's
 * id instead. Admin-only.
 */
export async function POST(req: Request) {
  const g = await brandMapAdmin(req, { on: () => isBrandMapScaleEnabled() && isBrandMapResearchEnabled(), offError: "research_disabled" });
  if (!g.ok) return g.response;
  return startRunFromRequest(g.ctx, await req.json().catch(() => null));
}
