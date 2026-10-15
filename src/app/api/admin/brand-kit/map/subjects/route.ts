import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { createSubjectFromRequest, listSubjectsFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

/**
 * A brand's subjects (all, one group's with `group=<id>`, the ungrouped with `group=none`, proposals with `status=proposed`), and adding one. Admin-only.
 */
export async function GET(req: Request) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  return listSubjectsFromRequest(g.ctx, new URL(req.url));
}

export async function POST(req: Request) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  return createSubjectFromRequest(g.ctx, await req.json().catch(() => null));
}
