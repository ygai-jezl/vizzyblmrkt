import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { forTenant } from "./repository";
import type {
  FirestoreLike,
  KnowledgeCollectionLike,
  TenantContext,
} from "./types";
import type { KnowledgeOwnerKind } from "@/lib/types/knowledgeBase";

/**
 * Tenant-layer access for a knowledge-base vector subcollection. Ownership is
 * POLYMORPHIC — a knowledge base hangs off either a campaign or a workspace:
 *   {campaigns|workspaces}/{ownerId}/knowledge_bases
 * in the tenant's REGIONAL database.
 *
 * This is the sanctioned place (outside the generic TenantCollection) that
 * reaches a SUBCOLLECTION directly + uses Firestore native vector search.
 *
 * SECURITY: this accessor does NOT itself enforce tenant ownership — the parent
 * owner document is the boundary. Callers MUST first verify ownership with
 * `verifyOwner(ctx, ownerKind, ownerId)` (returns false for a foreign/missing
 * owner), and the retrieval path additionally re-checks each chunk's stamped
 * tenantId/ownerId.
 */
export const KNOWLEDGE_SUBCOLLECTION = "knowledge_bases" as const;

const OWNER_COLLECTION: Record<KnowledgeOwnerKind, string> = {
  campaign: "campaigns",
  workspace: "workspaces",
};

export function knowledgeChunksRef(
  ctx: TenantContext,
  ownerKind: KnowledgeOwnerKind,
  ownerId: string,
  /** Test seam: inject a fake vector-capable collection. */
  override?: KnowledgeCollectionLike,
): KnowledgeCollectionLike {
  if (override) return override;
  if (!ownerId) throw new Error("knowledgeChunksRef requires an ownerId");
  const db = getDb(databaseIdForRegion(ctx.region));
  return db
    .collection(OWNER_COLLECTION[ownerKind])
    .doc(ownerId)
    .collection(KNOWLEDGE_SUBCOLLECTION) as unknown as KnowledgeCollectionLike;
}

/**
 * Verify the (tenant-scoped) owner exists before any knowledge access. Returns
 * false for a foreign-tenant or missing owner (TenantCollection.getById is
 * tenant-scoped). `db` is a test seam forwarded to forTenant.
 */
export async function verifyOwner(
  ctx: TenantContext,
  ownerKind: KnowledgeOwnerKind,
  ownerId: string,
  db?: FirestoreLike,
): Promise<boolean> {
  const repo = forTenant(ctx, db);
  const doc =
    ownerKind === "campaign"
      ? await repo.campaigns.getById(ownerId)
      : await repo.workspaces.getById(ownerId);
  return Boolean(doc);
}

/** Raw (real-Firestore) chunk subcollection for an owner. Tenant-layer only. */
function rawChunksCollection(
  ctx: TenantContext,
  ownerKind: KnowledgeOwnerKind,
  ownerId: string,
) {
  return getDb(databaseIdForRegion(ctx.region))
    .collection(OWNER_COLLECTION[ownerKind])
    .doc(ownerId)
    .collection(KNOWLEDGE_SUBCOLLECTION);
}

export interface KnowledgeChunkView {
  id: string;
  title: string;
  path: string | null;
  heading: string | null;
  content: string;
  tokenCount: number;
  chunkIndex: number;
  topic: string | null;
  tags: string[];
}

/**
 * List an owner's knowledge chunks (for the Browse view), optionally for one
 * ticket. CALLER MUST have verified owner ownership first (verifyOwner). Returns
 * a lightweight view (no embedding).
 */
export async function listKnowledgeChunks(
  ctx: TenantContext,
  ownerKind: KnowledgeOwnerKind,
  ownerId: string,
  opts: { ticketId?: string; limit?: number } = {},
): Promise<KnowledgeChunkView[]> {
  const col = rawChunksCollection(ctx, ownerKind, ownerId);
  const base = opts.ticketId ? col.where("ticketId", "==", opts.ticketId) : col;
  const snap = await base.limit(Math.min(Math.max(opts.limit ?? 100, 1), 500)).get();
  const rows = snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id,
      title: typeof x.title === "string" ? x.title : "",
      path: typeof x.path === "string" ? x.path : null,
      heading: typeof x.heading === "string" ? x.heading : null,
      content: typeof x.content === "string" ? x.content : "",
      tokenCount: typeof x.tokenCount === "number" ? x.tokenCount : 0,
      chunkIndex: typeof x.chunkIndex === "number" ? x.chunkIndex : 0,
      topic: typeof x.topic === "string" ? x.topic : null,
      tags: Array.isArray(x.tags) ? (x.tags as string[]) : [],
    };
  });
  rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
  return rows;
}

/**
 * Delete an owner's knowledge chunks (all, or just one ticket's). CALLER MUST
 * have verified ownership first. Returns the count deleted.
 */
export async function deleteOwnerKnowledge(
  ctx: TenantContext,
  ownerKind: KnowledgeOwnerKind,
  ownerId: string,
  opts: { ticketId?: string } = {},
): Promise<number> {
  const col = rawChunksCollection(ctx, ownerKind, ownerId);
  const base = opts.ticketId ? col.where("ticketId", "==", opts.ticketId) : col;
  const snap = await base.get();
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = col.firestore.batch();
    for (const d of docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
  return docs.length;
}
