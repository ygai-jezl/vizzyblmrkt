import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { proposalsFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

/**
 * Accept or dismiss proposals, many at once (subjects, questions, buying situations). Admin-only.
 */
export async function POST(req: Request) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  return proposalsFromRequest(g.ctx, await req.json().catch(() => null));
}
