import { z } from "zod";

/**
 * Per-published-post performance record — the metric time-series + derived reward that
 * powers the history-aware Distribute feedback loop. One doc per published post (X or
 * LinkedIn company-page), top-level in the REGIONAL DB (`post_performance`), tenant-scoped.
 *
 * Metrics from both platforms are CUMULATIVE lifetime counts, so we keep dated `snapshots`
 * (captured by the multi-poll harvest at ~48/72/…/168h) to derive velocity and a STABLE
 * +7d measurement window — never "lifetime of an old post", which would reward age. The
 * `measurement` is filled once the poll window closes; `reward`/`clusterId` are filled later
 * by the offline reconciliation pass (baseline needs the tenant×channel cohort). Fields for
 * later phases (`topicality`, `reward`, `injectionCohort`) are declared now so the schema is
 * stable across phases (mirrors the ScheduledPost "declare later kinds now" convention).
 */

/** Common metric shape both platforms map into. Optional fields are platform-specific
 *  (uniqueImpressions/clicks are LinkedIn-only; X has neither). */
export const MetricRawSchema = z.object({
  impressions: z.number().nonnegative().default(0),
  uniqueImpressions: z.number().nonnegative().nullable().optional(),
  clicks: z.number().nonnegative().nullable().optional(),
  likes: z.number().nonnegative().default(0),
  comments: z.number().nonnegative().default(0),
  shares: z.number().nonnegative().default(0),
});
export type MetricRaw = z.infer<typeof MetricRawSchema>;

export const PostMetricSource = z.enum(["x", "linkedin_org"]);
export type PostMetricSource = z.infer<typeof PostMetricSource>;

export const PostMetricSnapshotSchema = z.object({
  /** ISO capture time. */
  at: z.string(),
  /** Hours since publish (the job's parent createdAt) — the time-series x-axis. */
  ageHours: z.number().nonnegative(),
  source: PostMetricSource,
  raw: MetricRawSchema,
});
export type PostMetricSnapshot = z.infer<typeof PostMetricSnapshotSchema>;

/** The stable measurement at window close (~+7d). `actions`/`ER`/`composite` are the
 *  drift-normalized reward intermediates (see feedback/metrics.ts). */
export const PostMeasurementSchema = z.object({
  windowClosedAt: z.string(),
  ageHoursAtMeasure: z.number().nonnegative(),
  metrics: MetricRawSchema,
  actions: z.number(),
  ER: z.number(),
  composite: z.number(),
  /** Early-signal engagement rate captured near +48h (provisional), if available. */
  velocity48h: z.number().nullable().optional(),
});
export type PostMeasurement = z.infer<typeof PostMeasurementSchema>;

/** Reward output (filled by the P2 reconciliation pass). */
export const PostRewardSchema = z.object({
  R_baseline: z.number(),
  R_final: z.number(),
  z: z.number(),
  z_cluster: z.number(),
  novelty: z.number(),
  tier: z.enum(["cold", "quarantined", "scored", "promoted", "below"]),
  computedAt: z.string(),
});
export type PostReward = z.infer<typeof PostRewardSchema>;

/** Topicality stamp (P4): how on-trend the copy was at generation time. */
export const PostTopicalitySchema = z.object({
  score: z.number(),
  matchedLabel: z.string().max(120),
  momentum: z.string().max(20).nullable().optional(),
  snapshotId: z.string().max(200).nullable().optional(),
});
export type PostTopicality = z.infer<typeof PostTopicalitySchema>;

const MAX_SNAPSHOTS = 12;

export const PostPerformanceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  channel: z.string().max(40),
  /** Parent scheduled-post dedupeKey (the `perf:` prefix stripped) — one record per post. */
  sourcePostId: z.string().max(200),
  sourceRemoteId: z.string().max(200).nullable().optional(),
  workspaceId: z.string(),
  contentPlanId: z.string(),
  nodeId: z.string(),
  /** Org URN whose page owns the post (LinkedIn stats key); null for X/personal. */
  authorUrn: z.string().max(200).nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  format: z.string().max(40).nullable().optional(),
  /** The published copy (our own machine text) — embedded for near-duplicate clustering +
   *  reused as the exemplar body. PII-scrubbed at embed/record time, not here. */
  body: z.string().max(4000).default(""),
  /** Hashtags parsed from the published copy (leaderboard key), lowercased. */
  hashtags: z.array(z.string().max(80)).max(10).default([]),
  topicality: PostTopicalitySchema.nullable().optional(),
  snapshots: z.array(PostMetricSnapshotSchema).max(MAX_SNAPSHOTS).default([]),
  measurement: PostMeasurementSchema.nullable().optional(),
  /** Reward lifecycle — the reconciliation pass queries `settled` and advances to `scored`. */
  rewardStatus: z.enum(["collecting", "settled", "scored"]).default("collecting"),
  reward: PostRewardSchema.nullable().optional(),
  clusterId: z.string().max(120).nullable().optional(),
  injectionCohort: z.enum(["injected", "holdout"]).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PostPerformance = z.infer<typeof PostPerformanceSchema>;

export const POST_PERFORMANCE_LIMITS = { MAX_SNAPSHOTS } as const;

/** One performance record per (tenant, channel, source post). */
export function postPerformanceDocId(
  tenantId: string,
  channel: string,
  sourcePostId: string,
): string {
  return `pp:${encodeURIComponent(tenantId)}:${channel}:${sourcePostId}`;
}
