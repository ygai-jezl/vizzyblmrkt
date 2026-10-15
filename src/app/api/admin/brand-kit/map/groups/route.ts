import { brandMapAdmin, brandMapReader } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { createGroupFromRequest, groupsFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

/**
 * A brand's groups of subjects, and adding one. Members read; admins change.
 */
export async function GET(req: Request) {
  const g = await brandMapReader(req, SCALE);
  if (!g.ok) return g.response;
  return groupsFromRequest(g.ctx);
}

export async function POST(req: Request) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  return createGroupFromRequest(g.ctx, await req.json().catch(() => null));
}
