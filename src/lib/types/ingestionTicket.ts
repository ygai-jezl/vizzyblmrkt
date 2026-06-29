import { z } from "zod";
import { KnowledgeChunkSource } from "./knowledgeBase";
import { Region } from "./tenant";

/**
 * Durable status record for one knowledge-ingestion run. Lives in the
 * tenant-scoped, regional `ingestion_tickets` collection (top-level, so it rides
 * the standard TenantCollection isolation control). The dispatch route creates
 * it `pending` and triggers the Cloud Run Job; the worker advances it through
 * `running → embedding → done|partial|failed`, giving operators a pollable
 * status + a "sources for this launch" list.
 *
 * Idempotent like email_jobs: the document id IS the `dedupeKey`, so re-posting
 * the same (campaign, source, url, ref) returns "duplicate" instead of spawning
 * a second Job.
 */
export const IngestionStatus = z.enum([
  "pending", // created; Job triggered, not yet picked up
  "running", // worker is cloning/scraping
  "embedding", // worker is embedding + writing chunks
  "done", // all chunks written
  "partial", // some chunks written, then a non-fatal failure
  "failed", // fatal failure before any usable output
]);
export type IngestionStatus = z.infer<typeof IngestionStatus>;

export const IngestionTicketSchema = z.object({
  /** Document id === dedupeKey (idempotency). */
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string(),
  source: KnowledgeChunkSource,
  /** The repo/page URL to ingest. */
  sourceUri: z.string(),
  /** Optional git branch/tag (repos only). */
  ref: z.string().nullable().optional(),
  /** Optional glob filter for which files to ingest (repos only). */
  includeGlobs: z.array(z.string()).nullable().optional(),
  status: IngestionStatus,
  dedupeKey: z.string(),
  attempts: z.number().int().nonnegative(),
  /** Set while a worker holds the ticket; lets a stale claim be reclaimed. */
  claimedAt: z.string().nullable().optional(),
  chunksWritten: z.number().int().nonnegative(),
  pagesProcessed: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
  /** Residency stamp — matches the campaign's region (where chunks + embeddings live). */
  region: Region,
  createdAt: z.string(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
});
export type IngestionTicket = z.infer<typeof IngestionTicketSchema>;
