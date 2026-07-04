import type { AutoPlug } from "@/lib/types/scheduledPost";
import type { XPublicMetrics } from "@/lib/social/x/client";

/**
 * Auto-Plug: once a published post crosses an engagement threshold, post a promo
 * comment under it. Pure helpers here; the impure poll + comment live in the worker
 * (scheduler.ts runAutoPlugComment).
 */

/** How long after publish to poll metrics and (maybe) fire the comment. One-shot. */
export const AUTO_PLUG_DELAY_MS = 24 * 60 * 60 * 1000; // 24h

/** Map an AutoPlug thresholdMetric to the matching X public metric. */
export function metricValue(metrics: XPublicMetrics, metric: AutoPlug["thresholdMetric"]): number {
  switch (metric) {
    case "likes":
      return metrics.likes;
    case "comments":
      return metrics.replies;
    case "reposts":
      return metrics.reposts;
  }
}

/** Has the post crossed its auto-plug threshold? */
export function thresholdCrossed(metrics: XPublicMetrics, rule: AutoPlug): boolean {
  return metricValue(metrics, rule.thresholdMetric) >= rule.thresholdValue;
}
