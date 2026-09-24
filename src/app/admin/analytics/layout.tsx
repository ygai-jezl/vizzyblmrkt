import { isInsightsHubEnabled } from "@/lib/nav/flags";
import { isHashtagLeaderboardEnabled } from "@/lib/distribute/feedback/hashtags";
import { InsightsTabs } from "@/components/admin/insights/InsightsTabs";

/**
 * Insights (nav v2 phase 4): one hub for how every stage is doing — Overview ·
 * Launches · Email · Content · Journeys (and Market when it's switched on). With
 * the hub off, the analytics page renders exactly as before.
 */
export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  if (!isInsightsHubEnabled()) return <>{children}</>;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Insights</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          How every stage is performing, from first signup to activated user.
        </p>
      </div>
      <InsightsTabs market={isHashtagLeaderboardEnabled()} />
      {children}
    </div>
  );
}
