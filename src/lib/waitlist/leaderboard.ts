import { forTenant } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import { toPublicLeaderboardEntry, type PublicLeaderboardEntry } from "./masking";

/**
 * Build the public, PII-masked leaderboard for a campaign: the top
 * `leaderboardLength` referrers, ranked by score (referrals) then earliest
 * signup. Only signups with at least one referral appear — per the PRD an
 * enabled-but-empty leaderboard returns [] rather than listing unreferred users.
 *
 * Uses the tenant-scoped repository, so it only ever sees this tenant's data in
 * its region. Output is fully masked and safe to cache/serve publicly.
 */
export async function getLeaderboard(
  ctx: TenantContext,
  campaign: Campaign,
  db?: FirestoreLike,
): Promise<PublicLeaderboardEntry[]> {
  if (!campaign.usesLeaderboard || campaign.leaderboardLength <= 0) return [];

  // Rank by amountReferred directly (PRD: "highest number of referrals occupies
  // index 0"), NOT by score. score = amountReferred × spotsToMoveUponReferral
  // collapses to 0 for everyone when spots == 0 (a valid config — referrals as
  // vanity milestones), which would break the ordering. The `> 0` filter is a
  // range on the leading orderBy field, so the limit only ever counts real
  // referrers. Requires the (tenantId, campaignId, status, amountReferred DESC,
  // createdAt ASC) composite index.
  const rows = await forTenant(ctx, db).signups.find({
    where: [
      ["campaignId", "==", campaign.id],
      ["status", "==", "verified_active"],
      ["amountReferred", ">", 0],
    ],
    orderBy: [
      ["amountReferred", "desc"],
      ["createdAt", "asc"],
    ],
    limit: campaign.leaderboardLength,
  });

  return rows.map((s, i) => toPublicLeaderboardEntry(s, i + 1));
}
