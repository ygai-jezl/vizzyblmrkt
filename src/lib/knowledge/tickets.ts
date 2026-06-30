import { createHash } from "node:crypto";
import { forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type {
  KnowledgeChunkSource,
  KnowledgeOwnerKind,
} from "@/lib/types/knowledgeBase";
import type { IngestionStatus } from "@/lib/types/ingestionTicket";

/**
 * The knowledge-ingestion ticket queue (Firestore `ingestion_tickets`,
 * tenant-scoped, regional). Idempotent: the document id IS the dedupeKey, so
 * re-posting the same (tenant, owner, source, url, ref, globs) returns "duplicate"
 * instead of spawning a second Cloud Run Job. A terminal ticket can be re-ingested
 * (reset + re-dispatched).
 */

const ACTIVE_STATUSES: IngestionStatus[] = ["pending", "running", "embedding"];
const TERMINAL_STATUSES: IngestionStatus[] = ["done", "failed", "partial"];

export function maxActiveIngestions(): number {
  const n = Number(process.env.KNOWLEDGE_MAX_ACTIVE_INGESTIONS);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export interface EnqueueIngestionInput {
  ownerKind: KnowledgeOwnerKind;
  ownerId: string;
  source: KnowledgeChunkSource;
  sourceUri: string;
  ref?: string | null;
  includeGlobs?: string[] | null;
  /** Content Matrix topic id (optional). */
  topic: string | null;
  /** Normalized custom tags. */
  tags: string[];
}

/**
 * Deterministic ticket id / dedupeKey. tenantId is included so ids never collide
 * across tenants. topic/tags are editable metadata and NOT part of the key (the
 * same source re-ingested with a different topic is the same source).
 */
export function ingestionDedupeKey(
  tenantId: string,
  input: EnqueueIngestionInput,
): string {
  const h = createHash("sha256")
    .update(
      [
        tenantId,
        input.ownerKind,
        input.ownerId,
        input.source,
        input.sourceUri,
        input.ref ?? "",
        (input.includeGlobs ?? []).join(","),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 20);
  return `tkt_${h}`;
}

export async function activeIngestionCount(
  ctx: TenantContext,
  db?: FirestoreLike,
): Promise<number> {
  return forTenant(ctx, db).ingestionTickets.count([
    ["status", "in", ACTIVE_STATUSES],
  ]);
}

export type EnqueueResult =
  | { status: "created" | "duplicate" | "retried"; ticketId: string }
  | { status: "rate_limited"; ticketId: null };

export async function enqueueIngestionTicket(
  ctx: TenantContext,
  input: EnqueueIngestionInput,
  db?: FirestoreLike,
): Promise<EnqueueResult> {
  const repo = forTenant(ctx, db).ingestionTickets;
  const ticketId = ingestionDedupeKey(ctx.tenantId, input);
  const now = new Date().toISOString();

  const existing = await repo.getById(ticketId);
  if (existing) {
    // Still in-flight → idempotent no-op (do NOT re-trigger), regardless of cap.
    if (!TERMINAL_STATUSES.includes(existing.status)) {
      return { status: "duplicate", ticketId };
    }
    // Terminal → allow re-ingest: it becomes active again, so respect the cap;
    // refresh topic/tags too (they may have changed), then reset to pending.
    if ((await activeIngestionCount(ctx, db)) >= maxActiveIngestions()) {
      return { status: "rate_limited", ticketId: null };
    }
    await repo.update(ticketId, {
      status: "pending",
      topic: input.topic,
      tags: input.tags,
      lastError: null,
      claimedAt: null,
      chunksWritten: 0,
      pagesProcessed: 0,
      startedAt: null,
      finishedAt: null,
    });
    return { status: "retried", ticketId };
  }

  if ((await activeIngestionCount(ctx, db)) >= maxActiveIngestions()) {
    return { status: "rate_limited", ticketId: null };
  }
  try {
    await repo.create(ticketId, {
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      source: input.source,
      sourceUri: input.sourceUri,
      ref: input.ref ?? null,
      includeGlobs: input.includeGlobs ?? null,
      topic: input.topic,
      tags: input.tags,
      status: "pending",
      dedupeKey: ticketId,
      attempts: 0,
      claimedAt: null,
      chunksWritten: 0,
      pagesProcessed: 0,
      lastError: null,
      region: ctx.region,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    });
    return { status: "created", ticketId };
  } catch (err) {
    if (err instanceof TenantIsolationError) {
      return { status: "duplicate", ticketId };
    }
    throw err;
  }
}
