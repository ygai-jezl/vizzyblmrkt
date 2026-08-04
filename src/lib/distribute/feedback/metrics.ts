import type { XPublicMetrics } from "@/lib/social/x/client";
import type { LinkedInShareMetrics } from "@/lib/social/linkedin/stats";
import type { MetricRaw, PostMeasurement, PostMetricSnapshot } from "@/lib/types/postPerformance";

/**
 * Pure metric helpers for the Distribute performance loop: normalize each platform's
 * cumulative counts into a common shape, parse hashtags, and derive the drift-normalized
 * composite engagement + the stable +7d measurement from a post's snapshot series.
 * No I/O — fully unit-testable. The reward baseline/clustering lives in reward.ts (P2).
 */

const IMP_FLOOR = 50; // denominator floor: a 3-impression post can't post a huge rate
const MEASURE_MIN_AGE_HOURS = 168; // +7d stable window
const VELOCITY_AGE_HOURS = 48; // early provisional signal

function envNum(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Reward weights (env-tunable) — a share/comment is worth far more than a like. */
export function rewardWeights() {
  return {
    likes: envNum("POST_REWARD_W_LIKES", 1.0),
    comments: envNum("POST_REWARD_W_COMMENTS", 3.0),
    shares: envNum("POST_REWARD_W_SHARES", 4.0),
    clicks: envNum("POST_REWARD_W_CLICKS", 1.5),
  };
}

/** X: reposts+quotes are both amplification (→ shares); replies → comments; no clicks. */
export function xToCommon(m: XPublicMetrics): MetricRaw {
  return {
    impressions: m.impressions,
    likes: m.likes,
    comments: m.replies,
    shares: m.reposts + m.quotes,
  };
}

export function linkedinToCommon(m: LinkedInShareMetrics): MetricRaw {
  return {
    impressions: m.impressions,
    uniqueImpressions: m.uniqueImpressions,
    clicks: m.clicks,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
  };
}

/**
 * Composite engagement as a drift-normalized RATE (neutralizes follower/impression growth):
 * weighted actions over impressions (floored). `composite` == ER; kept as a distinct field so
 * a future blended leaderboard score can diverge from the reward's ER without a migration.
 */
export function compositeEngagement(raw: MetricRaw): { actions: number; ER: number; composite: number } {
  const w = rewardWeights();
  const clicks = raw.clicks ?? 0;
  const actions = w.likes * raw.likes + w.comments * raw.comments + w.shares * raw.shares + w.clicks * clicks;
  const ER = actions / Math.max(raw.impressions, IMP_FLOOR);
  return { actions, ER, composite: ER };
}

/** Hashtags from published copy — lowercased, per-tag length-capped (must stay ≤ the schema's
 *  max(80) or the post_performance create-parse throws and the post silently drops from the
 *  loop), deduped, and count-capped (leaderboard key). */
export function parseHashtags(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(/#([\p{L}0-9_]+)/gu)) {
    const tag = m[1]!.toLowerCase().slice(0, 80);
    if (tag) out.add(tag);
    if (out.size >= 10) break;
  }
  return [...out];
}

/**
 * The stable measurement at window close: prefer the latest snapshot at/after +7d (so we
 * measure a consistent window, not lifetime-of-old-post); else the latest available. Also
 * derives an early +48h velocity for a provisional reward. Returns null with no snapshots.
 */
export function computeMeasurement(
  snapshots: PostMetricSnapshot[],
  windowClosedAt: string,
): PostMeasurement | null {
  if (!snapshots.length) return null;
  const sorted = [...snapshots].sort((a, b) => a.ageHours - b.ageHours);
  const settled = sorted.filter((s) => s.ageHours >= MEASURE_MIN_AGE_HOURS);
  const chosen = settled.length ? settled[settled.length - 1]! : sorted[sorted.length - 1]!;
  const { actions, ER, composite } = compositeEngagement(chosen.raw);
  const early = sorted.find((s) => s.ageHours >= VELOCITY_AGE_HOURS) ?? sorted[0]!;
  const velocity48h = compositeEngagement(early.raw).ER;
  return {
    windowClosedAt,
    ageHoursAtMeasure: chosen.ageHours,
    metrics: chosen.raw,
    actions,
    ER,
    composite,
    velocity48h,
  };
}
