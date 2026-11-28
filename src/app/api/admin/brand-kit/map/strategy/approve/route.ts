import { approveFromRequest, strategyAdmin } from "@/lib/brandStrategy/adminApi";
import { forgetReviewCount } from "@/lib/review/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Approve strategy: the draft becomes what the writer, research, Next up and Vizzy read. Admins only.
 * Approving can settle the month's suggestion or start the weekly check again, so the brand's cached
 * Review count is forgotten.
 */
export async function POST(req: Request) {
  const g = await strategyAdmin(req);
  if (!g.ok) return g.response;
  const res = await approveFromRequest(g.ctx, await req.json().catch(() => null));
  if (res.ok) forgetReviewCount(g.ctx.tenantId);
  return res;
}
