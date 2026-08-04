import { listScoredForChannel } from "@/lib/tenant";
import { STEERING_CHANNELS } from "./steeringState";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { PostPerformance } from "@/lib/types/postPerformance";

/**
 * P6 tier (i) — the OWNED hashtag leaderboard: our own top-performing posts grouped by the hashtags
 * they used, ranked by the drift-normalized composite engagement. A read view over post_performance
 * (reuses the per-channel [tenantId,channel,rewardStatus,publishedAt] index — no new index), grouped
 * + ranked in memory. Cross-account/field leaderboards have no LinkedIn API (see the theme radar,
 * which reuses trending_topics instead).
 */

const PER_CHANNEL_SCAN = 120;
const DEFAULT_TAGS = 8;
const POSTS_PER_TAG = 5;

/** Gate for the Market Intelligence view (owned hashtag leaderboard + grounded theme radar). */
export function isHashtagLeaderboardEnabled(): boolean {
  return process.env.HASHTAG_LEADERBOARD_ENABLED === "true";
}

export interface LeaderboardPost {
  postId: string;
  channel: string;
  bodyExcerpt: string;
  composite: number;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  publishedAt: string | null;
}
export interface HashtagLeaderboardEntry {
  tag: string;
  postCount: number;
  medianComposite: number;
  topPosts: LeaderboardPost[];
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function toPost(p: PostPerformance): LeaderboardPost | null {
  const m = p.measurement;
  if (!m) return null;
  return {
    postId: p.sourcePostId ?? p.id,
    channel: p.channel,
    bodyExcerpt: (p.body ?? "").slice(0, 160),
    composite: m.composite,
    impressions: m.metrics.impressions,
    likes: m.metrics.likes,
    comments: m.metrics.comments,
    shares: m.metrics.shares,
    publishedAt: p.publishedAt ?? null,
  };
}

/**
 * Build the leaderboard across all channels: group scored posts by each hashtag they used, rank the
 * tags by post volume (then median composite), and within each tag keep the top posts by composite.
 */
export async function getHashtagLeaderboard(
  ctx: TenantContext,
  opts: { tags?: number; db?: FirestoreLike } = {},
): Promise<HashtagLeaderboardEntry[]> {
  const posts: PostPerformance[] = [];
  for (const channel of STEERING_CHANNELS) {
    const chan = await listScoredForChannel(ctx, channel, PER_CHANNEL_SCAN, opts.db).catch(() => []);
    posts.push(...chan);
  }
  const byTag = new Map<string, LeaderboardPost[]>();
  for (const p of posts) {
    const lp = toPost(p);
    if (!lp) continue;
    for (const tag of p.hashtags ?? []) {
      const arr = byTag.get(tag) ?? [];
      arr.push(lp);
      byTag.set(tag, arr);
    }
  }
  const entries: HashtagLeaderboardEntry[] = [...byTag.entries()].map(([tag, ps]) => {
    const sorted = [...ps].sort((a, b) => b.composite - a.composite);
    return {
      tag,
      postCount: ps.length,
      medianComposite: median(ps.map((p) => p.composite)),
      topPosts: sorted.slice(0, POSTS_PER_TAG),
    };
  });
  // Rank tags by how much proven volume they carry, then by their typical performance.
  entries.sort((a, b) => b.postCount - a.postCount || b.medianComposite - a.medianComposite);
  return entries.slice(0, opts.tags ?? DEFAULT_TAGS);
}
