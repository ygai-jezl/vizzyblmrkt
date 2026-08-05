import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { TenantContext, KnowledgeCollectionLike } from "./types";

/**
 * Per-post embedding store (`post_perf_vectors`, top-level REGIONAL, vector-indexed) that
 * powers the reward loop's near-duplicate CLUSTERING: each scored post's copy is embedded
 * once, and a new post's nearest neighbors (COSINE) form its "cluster" on the fly — no
 * separate cluster collection to drift. Carries the small scalars the reward needs on each
 * neighbor (`u`, `day`, `above`, `clusterId`) so a findNearest is self-sufficient. The ONLY
 * place permitted to touch this collection (ESLint isolation exempts src/lib/tenant/**).
 */
export const POST_PERF_VECTORS = "post_perf_vectors" as const;

export interface PostPerfVectorRow {
  /** Post id (== the post_performance sourcePostId-scoped id). */
  id: string;
  channel: string;
  /** Log-outcome of this post (reward units). */
  u: number;
  /** YYYY-MM-DD publish day (distinct-days spread for the promotion gate). */
  day: string;
  /** R_baseline ≥ R_PROMOTE when scored (drives cluster.aboveCount). */
  above: boolean;
  /** Cluster identity (the seed post's id) — shared across near-duplicates. */
  clusterId: string;
}

export interface PostPerfNeighbor extends PostPerfVectorRow {
  /** Cosine similarity to the query (1 − distance). */
  sim: number;
}

function ref(ctx: TenantContext): KnowledgeCollectionLike {
  const db = getDb(databaseIdForRegion(ctx.region));
  return db
    .collection(POST_PERF_VECTORS)
    .where("tenantId", "==", ctx.tenantId) as unknown as KnowledgeCollectionLike;
}

/** Persist a post's embedding + reward scalars (idempotent by post id). */
export async function writePostPerfVector(
  ctx: TenantContext,
  row: PostPerfVectorRow,
  vector: number[],
): Promise<void> {
  const db = getDb(databaseIdForRegion(ctx.region));
  await db
    .collection(POST_PERF_VECTORS)
    .doc(row.id)
    .set({
      tenantId: ctx.tenantId,
      channel: row.channel,
      u: row.u,
      day: row.day,
      above: row.above,
      clusterId: row.clusterId,
      embedding: FieldValue.vector(vector),
    });
}

/**
 * Nearest prior posts on this channel (COSINE), tenant-scoped. Excludes `excludeId` (the
 * post being scored, in case it was written already). Fail-soft: returns [] on any error so
 * the reward proceeds treating the post as novel. Not unit-tested against the fake (no
 * findNearest) — same posture as retrieveExemplars.
 */
export async function findNearestPostVectors(
  ctx: TenantContext,
  channel: string,
  queryVector: number[],
  k: number,
  excludeId?: string,
): Promise<PostPerfNeighbor[]> {
  try {
    const snap = await (ref(ctx).where("channel", "==", channel) as unknown as KnowledgeCollectionLike)
      .findNearest({
        vectorField: "embedding",
        queryVector,
        distanceMeasure: "COSINE",
        limit: k + (excludeId ? 1 : 0),
        distanceResultField: "_distance",
      })
      .get();
    const out: PostPerfNeighbor[] = [];
    for (const doc of snap.docs) {
      if (doc.id === excludeId) continue;
      const d = doc.data();
      if (d.tenantId !== ctx.tenantId || d.channel !== channel) continue;
      const dist = typeof d._distance === "number" ? d._distance : 1;
      out.push({
        id: doc.id,
        channel: String(d.channel ?? ""),
        u: typeof d.u === "number" ? d.u : 0,
        day: typeof d.day === "string" ? d.day : "",
        above: Boolean(d.above),
        clusterId: typeof d.clusterId === "string" ? d.clusterId : doc.id,
        sim: 1 - dist,
      });
      if (out.length >= k) break;
    }
    return out;
  } catch (err) {
    console.warn(
      "[findNearestPostVectors] failed:",
      err instanceof Error ? err.message.slice(0, 200) : "error",
    );
    return [];
  }
}
