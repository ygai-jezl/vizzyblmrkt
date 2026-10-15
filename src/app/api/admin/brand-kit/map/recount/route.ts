import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { recountFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

/**
 * The recount pass after "Read what's already there" (the map at any size): every subject's
 * counts worked out again, a batch per call, then every group's totals. Admin-only.
 */
export async function POST(req: Request) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  return recountFromRequest(g.ctx, await req.json().catch(() => null));
}
