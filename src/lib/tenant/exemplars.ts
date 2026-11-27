import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { FirestoreLike, TenantContext, KnowledgeCollectionLike } from "./types";
import {
  PerformanceExemplarSchema,
  isApprovedExemplar,
  type PerformanceExemplar,
} from "@/lib/types/performanceExemplar";

/**
 * Tenant-layer access for the Distribute performance-exemplar vector store
 * (`performance_exemplars`, top-level in the REGIONAL db). The ONLY place permitted
 * to touch this collection's Firestore + write its VectorValue embedding (the ESLint
 * isolation rule exempts src/lib/tenant/**).
 */
export const PERFORMANCE_EXEMPLARS = "performance_exemplars" as const;

/**
 * Vector-capable, tenant-scoped ref for findNearest retrieval. Pre-filters by
 * tenantId (isolation) up front; the caller adds `.where("channel","==",…)`. Test
 * seam: pass `override` to inject a fake vector collection.
 */
export function performanceExemplarsRef(
  ctx: TenantContext,
  override?: KnowledgeCollectionLike,
): KnowledgeCollectionLike {
  if (override) return override;
  const db = getDb(databaseIdForRegion(ctx.region));
  return db
    .collection(PERFORMANCE_EXEMPLARS)
    .where("tenantId", "==", ctx.tenantId) as unknown as KnowledgeCollectionLike;
}

/**
 * Persist an exemplar with its embedding VectorValue. The doc id is tenant-namespaced
 * by the caller (recordExemplar) so it can never overwrite another tenant's row in the
 * shared regional collection; tenantId is (re)stamped from context regardless.
 */
export async function writePerformanceExemplar(
  ctx: TenantContext,
  exemplar: Omit<PerformanceExemplar, "tenantId">,
  vector: number[],
  db?: FirestoreLike,
): Promise<void> {
  // Validate shape + caps STRUCTURALLY (defence in depth) so any caller — not just
  // recordExemplar's procedural caps — can't persist an over-long / malformed row.
  const parsed = PerformanceExemplarSchema.parse({ ...exemplar, tenantId: ctx.tenantId });
  const { id, ...data } = parsed;
  await regionalDb(ctx, db)
    .collection(PERFORMANCE_EXEMPLARS)
    .doc(id)
    .set({ ...data, embedding: FieldValue.vector(vector) });
}

function regionalDb(ctx: TenantContext, db?: FirestoreLike): FirestoreLike {
  return db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
}

/** An approved example as listed, without its embedding. */
export type ApprovedExemplarRow = Pick<PerformanceExemplar, "id" | "channel" | "text" | "tags" | "sourcePostId" | "createdAt">;

/** More than the writers ever keep per channel, so a listing always sees them all. */
const APPROVED_LIST_MAX = 200;

/**
 * The brand's approved examples on one channel (CONTENT_APPROVED_EXAMPLES_ENABLED), for keeping
 * only the newest. Equality filters only, the same two the vector index starts with, so no
 * composite index is needed; proven posts on the channel are left out in memory.
 */
export async function listApprovedExemplars(
  ctx: TenantContext,
  channel: string,
  db?: FirestoreLike,
): Promise<ApprovedExemplarRow[]> {
  const snap = await regionalDb(ctx, db)
    .collection(PERFORMANCE_EXEMPLARS)
    .where("tenantId", "==", ctx.tenantId)
    .where("channel", "==", channel)
    .limit(APPROVED_LIST_MAX)
    .get();
  const out: ApprovedExemplarRow[] = [];
  for (const doc of snap.docs) {
    const d = doc.data() as Partial<PerformanceExemplar>;
    if (d.tenantId !== ctx.tenantId || d.channel !== channel || !isApprovedExemplar(d)) continue;
    out.push({
      id: doc.id,
      channel,
      text: typeof d.text === "string" ? d.text : "",
      tags: Array.isArray(d.tags) ? d.tags : [],
      sourcePostId: typeof d.sourcePostId === "string" ? d.sourcePostId : "",
      createdAt: typeof d.createdAt === "string" ? d.createdAt : "",
    });
  }
  return out;
}

/**
 * Delete some of the brand's exemplars by id. Only ids under the brand's own prefix are touched, so
 * another brand's row in the shared regional collection can never be named. Returns how many.
 */
export async function deletePerformanceExemplars(
  ctx: TenantContext,
  ids: readonly string[],
  db?: FirestoreLike,
): Promise<number> {
  const prefix = `pex:${encodeURIComponent(ctx.tenantId)}:`;
  const col = regionalDb(ctx, db).collection(PERFORMANCE_EXEMPLARS);
  let n = 0;
  for (const id of new Set(ids)) {
    if (!id.startsWith(prefix)) continue;
    await col.doc(id).delete();
    n += 1;
  }
  return n;
}
