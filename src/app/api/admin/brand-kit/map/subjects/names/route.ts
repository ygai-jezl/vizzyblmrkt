import { brandMapReader } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { subjectNamesFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

/**
 * Every subject's name, for search (a few hundred KB at 5,000 subjects). Any member of the brand (an article's subject search reads it).
 */
export async function GET(req: Request) {
  const g = await brandMapReader(req, SCALE);
  if (!g.ok) return g.response;
  return subjectNamesFromRequest(g.ctx);
}
