import { brandMapAdmin, brandMapReader } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { editSubjectFromRequest, removeSubjectFromRequest, subjectFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

type RouteParams = { params: Promise<{ subjectId: string }> };

/**
 * One subject with its questions; editing it (naming the revision it started from) and removing it. Members read; admins change.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const g = await brandMapReader(req, SCALE);
  if (!g.ok) return g.response;
  const { subjectId } = await params;
  return subjectFromRequest(g.ctx, subjectId);
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  const { subjectId } = await params;
  return editSubjectFromRequest(g.ctx, subjectId, await req.json().catch(() => null));
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  const { subjectId } = await params;
  return removeSubjectFromRequest(g.ctx, subjectId);
}
