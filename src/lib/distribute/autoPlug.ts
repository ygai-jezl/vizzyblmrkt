import type { AutoPlug } from "@/lib/types/scheduledPost";
import type { XPublicMetrics } from "@/lib/social/x/client";

/**
 * Auto-Plug: once a published post crosses an engagement threshold, post a promo
 * comment under it. Pure helpers here; the impure poll + comment live in the worker
 * (scheduler.ts runAutoPlugComment).
 */

/** How long after publish to FIRST poll metrics and (maybe) fire the comment. */
export const AUTO_PLUG_DELAY_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * MULTI-POLL window: a post that crosses its threshold LATE (a slow-burn/next-day
 * viral post) still fires. A below-threshold poll re-arms itself every
 * AUTO_PLUG_POLL_INTERVAL_MS until AUTO_PLUG_WINDOW_MS has elapsed (measured from the
 * parent publish = the job's createdAt), after which it completes without firing.
 * With 24h first poll + 12h cadence + 72h window: polls at ~24/36/48/60/72h.
 */
export const AUTO_PLUG_POLL_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
export const AUTO_PLUG_WINDOW_MS = 72 * 60 * 60 * 1000; // 3 days

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
