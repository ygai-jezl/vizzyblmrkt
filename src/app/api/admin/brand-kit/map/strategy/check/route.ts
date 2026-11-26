import { checkAdmin, dismissCheckFromRequest } from "@/lib/brandStrategy/adminApi";
import { forgetReviewCount } from "@/lib/review/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dismiss the weekly strategy check's row in Review (STRATEGY_CHECK_ENABLED). Admins only. */
export async function POST(req: Request) {
  const g = await checkAdmin(req);
  if (!g.ok) return g.response;
  const res = await dismissCheckFromRequest(g.ctx);
  forgetReviewCount(g.ctx.tenantId);
  return res;
}
