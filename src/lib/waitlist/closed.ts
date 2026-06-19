import type { Campaign } from "@/lib/types/campaign";

/** Error key public endpoints return when a launch is archived/closed. */
export const WAITLIST_CLOSED = "waitlist_closed";

/**
 * A launch is "closed" to new public participation once it has been archived.
 * Archived launches keep ALL their data (and read-only surfaces like the status
 * check and the leaderboard stay working), but reject new signups and new voice
 * conversations. Presence of `archivedAt` is the single source of truth.
 */
export function isClosed(campaign: Pick<Campaign, "archivedAt">): boolean {
  return !!campaign.archivedAt;
}
