import type { XPublicMetrics } from "@/lib/social/x/client";

/**
 * When + whether a published post qualifies as a "proven performer" worth capturing
 * as an exemplar. Pure + testable; the impure poll/record lives in the worker
 * (scheduler.ts runPerformanceFetch).
 */

/** How long after publish to poll real engagement and (maybe) harvest an exemplar. */
export const PERFORMANCE_FETCH_DELAY_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * Minimum likes to qualify as a high performer. A flat, env-overridable bar for the
 * MVP — a per-account relative/percentile bar is a follow-up. Guards against a
 * non-positive / non-numeric override.
 */
export function highPerformerMinLikes(): number {
  const n = Number(process.env.DISTRIBUTE_EXEMPLAR_MIN_LIKES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 25;
}

export function exemplarQualifies(metrics: XPublicMetrics): boolean {
  return metrics.likes >= highPerformerMinLikes();
}

/** Lightweight structural tags describing WHY a post might have worked (length band,
 *  channel, format) — grounds retrieval so like-shaped drafts surface like exemplars. */
export function exemplarTags(text: string, channel: string, format?: string | null): string[] {
  const len = text.length;
  const band = len < 200 ? "len:short" : len < 800 ? "len:medium" : "len:long";
  const tags = [`ch:${channel}`, band];
  if (format) tags.push(`fmt:${format}`);
  return tags;
}
