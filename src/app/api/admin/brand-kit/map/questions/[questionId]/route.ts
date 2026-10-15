import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { editQuestionFromRequest, removeQuestionFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

type RouteParams = { params: Promise<{ questionId: string }> };

/**
 * Edit a question (its words, intent, buying situations, or the subject it is on), naming the revision it started from, or remove it. Admin-only.
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  const { questionId } = await params;
  return editQuestionFromRequest(g.ctx, questionId, await req.json().catch(() => null));
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  const { questionId } = await params;
  return removeQuestionFromRequest(g.ctx, questionId);
}
