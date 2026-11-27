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

/**
 * An example kept because a person approved it (CONTENT_APPROVED_EXAMPLES_ENABLED), not because of
 * its results: a workflow email or hub piece approved on the canvas, or a blog article found live.
 * Same store and shape as a proven post; `metric` says it was approved and one `piece:` tag says
 * which writer follows it, so a post writer never reads it and an email never follows a newsletter.
 */
export const APPROVED_METRIC = "approved" as const;

/** The writers that follow approved examples: workflow emails and hub pieces. */
export type ExamplePiece = "email" | "hub";

export const pieceTag = (piece: ExamplePiece) => `piece:${piece}`;

/** The piece an approved example came from, so a reader can open it in its plan. */
export interface ExampleRef {
  workspaceId: string;
  planId: string;
  nodeId: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An approved example's `sourcePostId`: `approved:<workspaceId>:<planId>:<nodeId>`, one per piece,
 * so approving it again replaces it. Null for an id that couldn't sit in a document id safely.
 */
export function approvedSourceId(ref: ExampleRef): string | null {
  const parts = [ref.workspaceId, ref.planId, ref.nodeId];
  return parts.every((p) => SAFE_ID.test(p)) ? `approved:${parts.join(":")}` : null;
}

/** The piece behind an approved example's `sourcePostId`, or null for any other row. */
export function approvedRefOf(sourcePostId: string): ExampleRef | null {
  const parts = sourcePostId.split(":");
  if (parts.length !== 4 || parts[0] !== "approved") return null;
  const [, workspaceId, planId, nodeId] = parts as [string, string, string, string];
  return [workspaceId, planId, nodeId].every((p) => SAFE_ID.test(p)) ? { workspaceId, planId, nodeId } : null;
}

/** The document id of an approved example, the same id recordExemplar gives any exemplar. */
export const approvedExemplarId = (tenantId: string, sourceId: string) => `pex:${encodeURIComponent(tenantId)}:${sourceId}`;

export function isApprovedExemplar(row: { metric?: { name?: unknown } | null }): boolean {
  return row.metric?.name === APPROVED_METRIC;
}
