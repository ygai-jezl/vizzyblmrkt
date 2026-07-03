import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { TenantContext, KnowledgeCollectionLike } from "./types";
import {
  PerformanceExemplarSchema,
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
): Promise<void> {
  // Validate shape + caps STRUCTURALLY (defence in depth) so any caller — not just
  // recordExemplar's procedural caps — can't persist an over-long / malformed row.
  const parsed = PerformanceExemplarSchema.parse({ ...exemplar, tenantId: ctx.tenantId });
  const { id, ...data } = parsed;
  const db = getDb(databaseIdForRegion(ctx.region));
  await db
    .collection(PERFORMANCE_EXEMPLARS)
    .doc(id)
    .set({ ...data, embedding: FieldValue.vector(vector) });
}
