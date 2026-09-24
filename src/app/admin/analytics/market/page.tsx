import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isInsightsHubEnabled } from "@/lib/nav/flags";
import {
  getHashtagLeaderboard,
  isHashtagLeaderboardEnabled,
  type HashtagLeaderboardEntry,
} from "@/lib/distribute/feedback/hashtags";
import { readTrendingTopicsRaw } from "@/lib/tenant/trendingTopics";
import type { TrendingTopic } from "@/lib/types/trendingTopics";
import { MarketIntelView } from "@/components/admin/MarketIntelView";

export const dynamic = "force-dynamic";

/** Insights › Market (nav v2 phase 4): Market Intelligence as a tab, only while it's switched on. */
export default async function InsightsMarketPage() {
  if (!isInsightsHubEnabled() || !isHashtagLeaderboardEnabled()) notFound();
  const ctx = await requireAdminContext();
  const [leaderboard, trends] = await Promise.all([
    getHashtagLeaderboard(ctx).catch((err): HashtagLeaderboardEntry[] => {
      console.error("[insights/market] leaderboard failed (index building?)", err);
      return [];
    }),
    readTrendingTopicsRaw(ctx)
      .then((doc): TrendingTopic[] => doc?.topics ?? [])
      .catch((err): TrendingTopic[] => {
        console.error("[insights/market] trends failed", err);
        return [];
      }),
  ]);
  return <MarketIntelView leaderboard={leaderboard} trends={trends} />;
}
