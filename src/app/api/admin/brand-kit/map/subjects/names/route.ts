import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { subjectNamesFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

/**
 * Every subject's name, for search (a few hundred KB at 5,000 subjects). Admin-only.
 */
export async function GET(req: Request) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  return subjectNamesFromRequest(g.ctx);
}
