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

  const rows = await forTenant(ctx, db).signups.find({
    where: [
      ["campaignId", "==", campaign.id],
      ["status", "==", "verified_active"],
    ],
    orderBy: [
      ["score", "desc"],
      ["createdAt", "asc"],
    ],
    limit: campaign.leaderboardLength,
  });

  // score = amountReferred × spots, so 0-referral signups sort last; filtering
  // after the limit still yields the true top referrers (up to leaderboardLength).
  return rows
    .filter((s) => s.amountReferred > 0)
    .map((s, i) => toPublicLeaderboardEntry(s, i + 1));
}
