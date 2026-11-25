import { brandCanUse } from "@/lib/plans/brandAccess";
import { brandMonthlyLimit } from "@/lib/plans/limits";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { reviewsThisMonth } from "./refreshRecords";

/**
 * Whether the brand may start a refresh review now (BLOG_REFRESH_ENABLED): it may use
 * article_refresh (its plan, or a grant where this copy keeps the feature for granted brands), and
 * it has reviews left this month (20 by default; a plan, this copy or the brand can change it).
 * Every way a review starts asks here: the article, Vizzy and the autopilot.
 */
export async function mayStartReview(
  ctx: TenantContext,
  deps: { db?: FirestoreLike; now?: () => Date; loadTenant?: (id: string) => Promise<Tenant | null> } = {},
): Promise<{ ok: true; used: number; limit: number } | { ok: false; status: number; error: "not_included" | "monthly_limit" }> {
  if (!(await brandCanUse(ctx, "article_refresh", deps.loadTenant))) return { ok: false, status: 403, error: "not_included" };
  const [used, limit] = await Promise.all([reviewsThisMonth(ctx, deps).catch(() => 0), brandMonthlyLimit(ctx, "article_refresh", deps.loadTenant)]);
  if (used >= limit) return { ok: false, status: 429, error: "monthly_limit" };
  return { ok: true, used, limit };
}
