import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isBrandMapResearchEnabled, isBrandMapSituationsEnabled } from "@/lib/brandMap/flags";
import { situationQuestionsFromRequest } from "@/lib/brandMap/situationsApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ situationId: string }> };

/**
 * "Find buying situations", step 2 for one situation (a step of the same run): the questions
 * people in it ask, each placed in a subject or a new one, proposed. Admin-only.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, { on: () => isBrandMapSituationsEnabled() && isBrandMapResearchEnabled(), offError: "situations_disabled" });
  if (!g.ok) return g.response;
  const { situationId } = await params;
  return situationQuestionsFromRequest(g.ctx, situationId, await req.json().catch(() => null));
}
