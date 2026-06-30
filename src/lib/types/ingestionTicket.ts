import { z } from "zod";
import { KnowledgeChunkSource, KnowledgeOwnerKind } from "./knowledgeBase";
import { Region } from "./tenant";

/**
 * Durable status record for one knowledge-ingestion run. Lives in the
 * tenant-scoped, regional `ingestion_tickets` collection (top-level). The
 * dispatch route creates it `pending` + triggers the Cloud Run Job; the worker
 * advances it `running → embedding → done|partial|failed`. Idempotent: the doc id
 * IS the `dedupeKey`.
 *
 * Owns a knowledge source for a polymorphic owner (campaign or workspace), tagged
 * with a Content Matrix `topic` (required) + free-form `tags` (queryable filters).
 */
export const IngestionStatus = z.enum([
  "pending",
  "running",
  "embedding",
  "done",
  "partial",
  "failed",
]);
export type IngestionStatus = z.infer<typeof IngestionStatus>;

export const IngestionTicketSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Polymorphic owner this source belongs to. */
  ownerKind: KnowledgeOwnerKind,
  ownerId: z.string(),
  source: KnowledgeChunkSource,
  sourceUri: z.string(),
  ref: z.string().nullable().optional(),
  includeGlobs: z.array(z.string()).nullable().optional(),
  /** Content Matrix topic id (OPTIONAL). */
  topic: z.string().nullable().default(null),
  /** Free-form custom tags (normalized). */
  tags: z.array(z.string()),
  status: IngestionStatus,
  dedupeKey: z.string(),
  attempts: z.number().int().nonnegative(),
  claimedAt: z.string().nullable().optional(),
  chunksWritten: z.number().int().nonnegative(),
  pagesProcessed: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
  region: Region,
  createdAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
});
export type IngestionTicket = z.infer<typeof IngestionTicketSchema>;
