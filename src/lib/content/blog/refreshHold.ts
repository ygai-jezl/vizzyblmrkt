import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";

/**
 * Whether a refresh review is running on an article (BLOG_REFRESH_ENABLED). Kept apart from the
 * review itself so the routes that ask (Regenerate, Research) don't load the review's code.
 */

export const reviewId = (planId: string) => `ar_${planId}`;

export const REVIEW_RUNNING = { error: "review_running" } as const;

/** Regenerate and Research wait while a review runs: they would replace the copy it is reading. */
export async function reviewHolds(ctx: TenantContext, planId: string, deps: { db?: FirestoreLike } = {}): Promise<boolean> {
  if (!isBlogRefreshEnabled()) return false;
  const r = await forTenant(ctx, deps.db).articleReviews.getById(reviewId(planId)).catch(() => null);
  return Boolean(r?.active);
}
