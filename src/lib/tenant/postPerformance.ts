import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { TenantContext, KnowledgeCollectionLike, FirestoreLike } from "./types";
import {
  PostPerformanceSchema,
  POST_PERFORMANCE_LIMITS,
  type PostPerformance,
  type PostMetricSnapshot,
  type PostMeasurement,
  type PostReward,
} from "@/lib/types/postPerformance";

/**
 * Tenant-layer access for the Distribute performance time-series (`post_performance`,
 * top-level in the REGIONAL db). The ONLY place permitted to touch this collection's
 * Firestore (the ESLint isolation rule exempts src/lib/tenant/**). Tenant isolation
 * mirrors exemplars.ts: prefilter tenantId on reads, restamp from ctx on writes. Every
 * function takes an optional `db` (FirestoreLike) so the worker can thread a fake in tests.
 */
export const POST_PERFORMANCE = "post_performance" as const;

const regionalDb = (ctx: TenantContext, db?: FirestoreLike): FirestoreLike =>
  db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);

/** The immutable link-back + descriptor fields set once when a record is created. */
export interface PostPerformanceBase {
  channel: string;
  sourcePostId: string;
  sourceRemoteId?: string | null;
  workspaceId: string;
  contentPlanId: string;
  nodeId: string;
  authorUrn?: string | null;
  publishedAt?: string | null;
  format?: string | null;
  body?: string;
  hashtags?: string[];
  /** Holdout cohort stamped at capture (from the node id) so injected−holdout lift is readable. */
  injectionCohort?: "injected" | "holdout";
}

/** Query ref (tenant-prefiltered) for baseline / leaderboard reads. */
export function postPerformanceRef(
  ctx: TenantContext,
  override?: KnowledgeCollectionLike,
): KnowledgeCollectionLike {
  if (override) return override;
  const db = getDb(databaseIdForRegion(ctx.region));
  return db
    .collection(POST_PERFORMANCE)
    .where("tenantId", "==", ctx.tenantId) as unknown as KnowledgeCollectionLike;
}

/**
 * Append a metric snapshot to a post's record, creating it on first poll, and RETURN the
 * merged snapshot series (so a caller settling the window needs no read-back). Idempotent
 * per whole-hour age bucket (a double-run of the same poll REPLACES that bucket). Safe
 * without a transaction: the parent post's claim lease serializes processing, and this doc
 * is touched only by that post's single perf job. The base descriptor is written only on
 * create; later polls touch snapshots + updatedAt.
 */
export async function upsertPostMetricSnapshot(
  ctx: TenantContext,
  input: { id: string; base: PostPerformanceBase; snapshot: PostMetricSnapshot },
  db?: FirestoreLike,
): Promise<PostMetricSnapshot[]> {
  const ref = regionalDb(ctx, db).collection(POST_PERFORMANCE).doc(input.id);
  const nowIso = input.snapshot.at;
  const cur = await ref.get();
  if (!cur.exists) {
    const doc = PostPerformanceSchema.parse({
      ...input.base,
      hashtags: input.base.hashtags ?? [],
      tenantId: ctx.tenantId,
      id: input.id,
      snapshots: [input.snapshot],
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const { id: _id, ...data } = doc;
    void _id;
    await ref.set(data);
    return doc.snapshots;
  }
  const data = cur.data() as PostPerformance;
  const existing = Array.isArray(data.snapshots) ? data.snapshots : [];
  const bucket = Math.floor(input.snapshot.ageHours);
  const merged = existing.filter((s) => Math.floor(s.ageHours) !== bucket);
  merged.push(input.snapshot);
  merged.sort((a, b) => a.ageHours - b.ageHours);
  const capped = merged.slice(-POST_PERFORMANCE_LIMITS.MAX_SNAPSHOTS);
  await ref.update({ snapshots: capped, updatedAt: nowIso });
  return capped;
}

/** Store the settled +7d measurement (P1). `update` merges into the existing record (the
 *  doc always exists here — a snapshot was upserted first) — never clobbers base/snapshots. */
export async function writePostMeasurement(
  ctx: TenantContext,
  id: string,
  measurement: PostMeasurement,
  db?: FirestoreLike,
): Promise<void> {
  await regionalDb(ctx, db)
    .collection(POST_PERFORMANCE)
    .doc(id)
    .update({ measurement, rewardStatus: "settled", updatedAt: measurement.windowClosedAt });
}

/** Store the reward + cluster assignment (P2 reconciliation pass). */
export async function writePostReward(
  ctx: TenantContext,
  id: string,
  patch: { reward: PostReward; clusterId?: string | null },
  db?: FirestoreLike,
): Promise<void> {
  await regionalDb(ctx, db)
    .collection(POST_PERFORMANCE)
    .doc(id)
    .update({
      reward: patch.reward,
      rewardStatus: "scored",
      ...(patch.clusterId !== undefined ? { clusterId: patch.clusterId } : {}),
      updatedAt: patch.reward.computedAt,
    });
}

/**
 * The reconciliation work-list: settled-but-unscored posts for a channel, oldest first
 * (so the baseline cohort grows monotonically as we score). Read-modify by the reward pass.
 */
export async function listSettledForReward(
  ctx: TenantContext,
  channel: string,
  limit: number,
  db?: FirestoreLike,
): Promise<PostPerformance[]> {
  const snap = await regionalDb(ctx, db)
    .collection(POST_PERFORMANCE)
    .where("tenantId", "==", ctx.tenantId)
    .where("channel", "==", channel)
    .where("rewardStatus", "==", "settled")
    .orderBy("publishedAt", "asc")
    .limit(limit)
    .get();
  return snap.docs.flatMap((d) => {
    const p = PostPerformanceSchema.safeParse({ ...d.data(), id: d.id });
    return p.success ? [p.data] : [];
  });
}

/**
 * The baseline cohort: this tenant×channel's already-scored posts published since `sinceIso`
 * (a rolling recent window, so the baseline tracks current follower scale). Used to compute
 * the median+MAD the new post is scored against.
 */
export async function listBaselineCohort(
  ctx: TenantContext,
  channel: string,
  sinceIso: string,
  limit: number,
  db?: FirestoreLike,
): Promise<PostPerformance[]> {
  const snap = await regionalDb(ctx, db)
    .collection(POST_PERFORMANCE)
    .where("tenantId", "==", ctx.tenantId)
    .where("channel", "==", channel)
    .where("rewardStatus", "==", "scored")
    .where("publishedAt", ">=", sinceIso)
    // MOST-RECENT first: without an explicit order, Firestore implicitly orders by the
    // inequality field ASCENDING, so limit() would keep the OLDEST posts and the baseline
    // would go ~90d stale for a high-volume tenant. The composite index serves this via
    // reverse-scan (equality prefix + single trailing order).
    .orderBy("publishedAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.flatMap((d) => {
    const p = PostPerformanceSchema.safeParse({ ...d.data(), id: d.id });
    return p.success ? [p.data] : [];
  });
}

/** All scored posts for a channel (newest first) — the input the pattern synthesis groups by
 *  cluster to find promotable patterns. Reuses the [tenantId,channel,rewardStatus,publishedAt] index. */
export async function listScoredForChannel(
  ctx: TenantContext,
  channel: string,
  limit: number,
  db?: FirestoreLike,
): Promise<PostPerformance[]> {
  const snap = await regionalDb(ctx, db)
    .collection(POST_PERFORMANCE)
    .where("tenantId", "==", ctx.tenantId)
    .where("channel", "==", channel)
    .where("rewardStatus", "==", "scored")
    .orderBy("publishedAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.flatMap((d) => {
    const p = PostPerformanceSchema.safeParse({ ...d.data(), id: d.id });
    return p.success ? [p.data] : [];
  });
}

export async function readPostPerformance(
  ctx: TenantContext,
  id: string,
  db?: FirestoreLike,
): Promise<PostPerformance | null> {
  const snap = await regionalDb(ctx, db).collection(POST_PERFORMANCE).doc(id).get();
  if (!snap.exists) return null;
  const parsed = PostPerformanceSchema.safeParse({ ...snap.data(), id: snap.id });
  return parsed.success ? parsed.data : null;
}
