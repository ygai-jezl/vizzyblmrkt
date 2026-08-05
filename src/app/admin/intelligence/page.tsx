import { StubPage } from "@/components/admin/StubPage";
import { requireAdminContext } from "@/lib/auth/session";
import {
  getHashtagLeaderboard,
  isHashtagLeaderboardEnabled,
  type HashtagLeaderboardEntry,
} from "@/lib/distribute/feedback/hashtags";
import { readTrendingTopicsRaw } from "@/lib/tenant/trendingTopics";
import type { TrendingTopic } from "@/lib/types/trendingTopics";
import { MarketIntelView } from "@/components/admin/MarketIntelView";

export const dynamic = "force-dynamic";

/**
 * Market Intelligence — two performance-derived signals:
 *  • the OWNED hashtag leaderboard (our own top posts per hashtag, real engagement); and
 *  • the grounded THEME RADAR (what's trending in the brand's space — qualitative, no cross-account
 *    engagement API exists for LinkedIn/X). Falls back to the stub until HASHTAG_LEADERBOARD_ENABLED.
 */
export default async function MarketIntelligencePage() {
  const ctx = await requireAdminContext();
  if (!isHashtagLeaderboardEnabled()) {
    return (
      <StubPage
        title="Market Intelligence"
        description="Market and competitor signals that inform GTM strategy — surfaced alongside your launch performance."
      />
    );
  }

  let leaderboard: HashtagLeaderboardEntry[] = [];
  let trends: TrendingTopic[] = [];
  try {
    leaderboard = await getHashtagLeaderboard(ctx);
  } catch (err) {
    console.error("[market-intel] leaderboard failed (index building?)", err);
  }
  try {
    // Display-only: use the raw read so a mildly-stale radar still shows (vs. blanking at TTL).
    const doc = await readTrendingTopicsRaw(ctx);
    trends = doc?.topics ?? [];
  } catch (err) {
    console.error("[market-intel] trends failed", err);
  }

  return <MarketIntelView leaderboard={leaderboard} trends={trends} />;
}
