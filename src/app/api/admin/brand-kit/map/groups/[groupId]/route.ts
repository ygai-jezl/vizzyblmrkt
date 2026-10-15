import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { removeGroupFromRequest, renameGroupFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

type RouteParams = { params: Promise<{ groupId: string }> };

/**
 * Rename a group (naming the revision it started from), or remove it: its subjects stay, ungrouped. Admin-only.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  const { groupId } = await params;
  return renameGroupFromRequest(g.ctx, groupId, await req.json().catch(() => null));
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  const { groupId } = await params;
  return removeGroupFromRequest(g.ctx, groupId);
}
