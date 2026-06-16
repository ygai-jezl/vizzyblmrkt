import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";

/**
 * Compute the 1-based waitlist rank for every verified signup in a campaign,
 * keyed by signup id. Orders by (amountReferred DESC, createdAt ASC) — the SAME
 * key the public leaderboard uses (see lib/waitlist/leaderboard.ts), NOT `score`:
 * score = amountReferred × spotsToMoveUponReferral collapses to 0 for everyone
 * when spots == 0 (a valid config), which would make rank purely chronological
 * and contradict the leaderboard. One ordered read per call; fine for waitlist
 * scale (sharded counters for very large lists are deferred).
 *
 * Reuses the composite index
 * (tenantId, campaignId, status, amountReferred DESC, createdAt ASC).
 */
export async function computeRanks(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<Map<string, number>> {
  const rows = await forTenant(ctx, db).signups.find({
    where: [
      ["campaignId", "==", campaignId],
      ["status", "==", "verified_active"],
    ],
    orderBy: [
      ["amountReferred", "desc"],
      ["createdAt", "asc"],
    ],
  });
  const ranks = new Map<string, number>();
  rows.forEach((s, i) => ranks.set(s.id, i + 1));
  return ranks;
}
