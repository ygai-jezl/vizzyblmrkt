import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Signup } from "@/lib/types/signup";
import { effectiveReferralWeight } from "./scoring";

/**
 * Compute the 1-based waitlist rank for every verified signup in a campaign,
 * keyed by signup id. Orders by (effectiveReferralWeight DESC, createdAt ASC) —
 * effective weight = amountReferred + engagementBonus (the boost a user earns by
 * finishing the post-signup AI conversation). This is the SAME base key the
 * public leaderboard uses (see lib/waitlist/leaderboard.ts), NOT `score`: score =
 * amountReferred × spotsToMoveUponReferral collapses to 0 for everyone when spots
 * == 0 (a valid config), which would make rank purely chronological.
 *
 * The Firestore read still orders by (amountReferred DESC, createdAt ASC) to
 * reuse the composite index (tenantId, campaignId, status, amountReferred DESC,
 * createdAt ASC); we then re-sort in memory by effective weight before assigning
 * ranks. When no signup has an engagementBonus, effective weight == amountReferred
 * so the order is identical to the indexed read — zero behaviour change.
 */
export async function computeRanks(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<Map<string, number>> {
  const ranks = new Map<string, number>();
  (await rankedSignups(ctx, campaignId, db)).forEach((s, i) => ranks.set(s.id, i + 1));
  return ranks;
}

/**
 * Every verified signup in a campaign, best rank first (the order computeRanks
 * numbers). Invites (nav v2 phase 4) take "the top N" from this list.
 */
export async function rankedSignups(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<Signup[]> {
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
  // Re-rank by effective weight; tie-break on createdAt ASC exactly as the query
  // does (ISO strings sort lexicographically), so feature-off order is unchanged.
  rows.sort((a, b) => {
    const wa = effectiveReferralWeight(a);
    const wb = effectiveReferralWeight(b);
    if (wa !== wb) return wb - wa;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
  return rows;
}
