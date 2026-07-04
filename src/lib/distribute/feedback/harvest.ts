import type { XPublicMetrics } from "@/lib/social/x/client";

/**
 * When + whether a published post qualifies as a "proven performer" worth capturing
 * as an exemplar. Pure + testable; the impure poll/record lives in the worker
 * (scheduler.ts runPerformanceFetch).
 */

/** How long after publish to FIRST poll real engagement and (maybe) harvest. */
export const PERFORMANCE_FETCH_DELAY_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * MULTI-POLL window: a post that accrues its likes over DAYS still gets captured as an
 * exemplar. A below-bar poll re-arms every PERFORMANCE_POLL_INTERVAL_MS until
 * PERFORMANCE_WINDOW_MS elapses (from the parent publish = the job's createdAt), then
 * completes without harvesting. With 48h first poll + 24h cadence + 7d window: polls at
 * ~48/72/96/120/144/168h.
 */
export const PERFORMANCE_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
export const PERFORMANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
