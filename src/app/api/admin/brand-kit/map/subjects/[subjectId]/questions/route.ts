import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { addQuestionFromRequest } from "@/lib/brandMap/recordsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCALE = { on: isBrandMapScaleEnabled, offError: "brand_map_scale_disabled" };

type RouteParams = { params: Promise<{ subjectId: string }> };

/**
 * Add a question to a subject. Admin-only.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, SCALE);
  if (!g.ok) return g.response;
  const { subjectId } = await params;
  return addQuestionFromRequest(g.ctx, subjectId, await req.json().catch(() => null));
}
