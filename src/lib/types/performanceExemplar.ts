import { z } from "zod";

/**
 * A PROVEN performer — a published post whose real engagement crossed a "high
 * performer" bar — captured so future Create generations can be weighted toward what
 * actually worked (the closed feedback loop). Lives in its OWN tenant-scoped
 * `performance_exemplars` collection (regional DB), DELIBERATELY separate from the
 * knowledge_bases chunk store: no ingestion-ticket/sourceUri baggage, no mirrored
 * scraper worker — it embeds in-app.
 *
 * `embedding` is a Firestore VectorValue written via FieldValue.vector([...]) (768-dim,
 * text-embedding-005 / RETRIEVAL_DOCUMENT) — NOT part of this Zod schema, exactly like
 * KnowledgeChunk. `channel` is the pre-filter for retrieval (a `x` exemplar should
 * only ground `x` generation). `text` is the scrubbed, PII-free skeleton that gets
 * embedded + shown as reference.
 */
export const PerformanceExemplarSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Channel this exemplar came from — the retrieval pre-filter. */
  channel: z.string().max(40),
  /** The proven copy/structure (PII-scrubbed, length-capped) — embedded + injected. */
  text: z.string().max(4000),
  /** Structural tags describing WHY it worked (hook type, length band, format…). */
  tags: z.array(z.string().max(60)).max(20).default([]),
  /** Snapshot of the metric that qualified it (for display + audit; not embedded). */
  metric: z.object({
    name: z.string().max(40), // "likes" | "comments" | "reposts"
    value: z.number().int().nonnegative(),
  }),
  /** The scheduled-post/publishedRef this was harvested from (link-back + dedupe). */
  sourcePostId: z.string().max(200),
  sourceRemoteId: z.string().max(200).nullable().optional(),
  createdAt: z.string(),
});
export type PerformanceExemplar = z.infer<typeof PerformanceExemplarSchema>;
