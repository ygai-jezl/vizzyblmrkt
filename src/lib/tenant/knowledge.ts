import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import type { KnowledgeCollectionLike, TenantContext } from "./types";

/**
 * Tenant-layer accessor for a launch's knowledge-base vector subcollection:
 *   campaigns/{campaignId}/knowledge_bases
 * in the tenant's REGIONAL database.
 *
 * This is the one sanctioned place (outside the generic TenantCollection) that
 * reaches a SUBCOLLECTION directly — TenantCollection only models top-level
 * collections, and Firestore native vector search (`.findNearest()`) is not part
 * of the structural FirestoreLike the isolation fake implements.
 *
 * SECURITY: this accessor does NOT itself enforce tenant ownership — the parent
 * `campaigns/{campaignId}` document is the tenant boundary. Callers MUST first
 * verify ownership with `forTenant(ctx).campaigns.getById(campaignId)` (a foreign
 * campaignId returns null there), and the retrieval path additionally re-checks
 * each returned chunk's stamped `tenantId`/`campaignId` (defence in depth). Every
 * chunk is written with those fields stamped by the ingestion worker.
 */
export const KNOWLEDGE_SUBCOLLECTION = "knowledge_bases" as const;

export function knowledgeChunksRef(
  ctx: TenantContext,
  campaignId: string,
  /** Test seam: inject a fake vector-capable collection. */
  override?: KnowledgeCollectionLike,
): KnowledgeCollectionLike {
  if (override) return override;
  if (!campaignId) throw new Error("knowledgeChunksRef requires a campaignId");
  const db = getDb(databaseIdForRegion(ctx.region));
  return db
    .collection("campaigns")
    .doc(campaignId)
    .collection(KNOWLEDGE_SUBCOLLECTION) as unknown as KnowledgeCollectionLike;
}
