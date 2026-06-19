import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import { computeRanks } from "./rank";
import {
  DEFAULT_SHARE_MESSAGE,
  parseEnabledPlatforms,
  type SharePlatformId,
} from "./socialPlatforms";
import { renderMergeVars } from "@/lib/email/mergeVars";

/**
 * The post-signup "payoff" data behind ShareSection — the gamified position, the
 * server-rendered share message (merge vars resolved, no link), the enabled
 * share platforms, and the referral link/count. Computed identically on every
 * surface that shows the success screen: the signup API, the status-check API,
 * and the double-opt-in post-verification landing. The `referralToken` itself is
 * NOT included here — callers that need it for the voice CTA already hold the
 * signup and pass `signup.referralToken` directly.
 */
export interface SharePayload {
  /** 1-based waitlist position; null until verified_active (or on compute error). */
  rank: number | null;
  amountReferred: number;
  referralLink: string;
  /** Already rendered server-side (merge vars resolved, WITHOUT the link). */
  shareMessage: string;
  enabledSharePlatforms: SharePlatformId[];
  hideCounts: boolean;
}

/**
 * Build the ShareSection payload for one signup. Rank only exists once the
 * signup is `verified_active` (unverified signups aren't counted yet), so it is
 * null otherwise — the share message still renders so a re-submit/unverified
 * response carries the same shape. A rank-computation failure degrades to a null
 * rank rather than failing the whole response.
 */
export async function buildSharePayload(
  ctx: TenantContext,
  campaign: Campaign,
  signup: Signup,
): Promise<SharePayload> {
  let rank: number | null = null;
  if (signup.status === "verified_active") {
    try {
      const ranks = await computeRanks(ctx, campaign.id);
      rank = ranks.get(signup.id) ?? null;
    } catch (err) {
      console.warn(`rank computation failed for ${campaign.id}:`, err);
    }
  }
  const shareMessage = renderMergeVars(
    campaign.configurationStyleJson.shareMessage || DEFAULT_SHARE_MESSAGE,
    { signup, campaign, rank: rank ?? undefined },
  );
  return {
    rank,
    amountReferred: signup.amountReferred,
    referralLink: signup.referralLink,
    shareMessage,
    enabledSharePlatforms: parseEnabledPlatforms(
      campaign.configurationStyleJson.enabledSharePlatforms,
    ),
    hideCounts: campaign.hideCounts,
  };
}
