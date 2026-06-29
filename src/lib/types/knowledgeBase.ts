import { z } from "zod";

/**
 * A semantically-chunked, vector-embedded knowledge snippet, ingested from an
 * external source (docs URL, live site, or a GitHub/GitLab repo) and used to
 * GROUND the AI copywriting agents (Agent 3, Vizzy, Campaign Ops) via Firestore
 * native vector search (`.findNearest()`).
 *
 * Stored as a SUBCOLLECTION under its launch:
 *   campaigns/{campaignId}/knowledge_bases/{chunkId}
 * in the tenant's REGIONAL database (residency: the chunk text never leaves its
 * region — see src/lib/tenant/knowledge.ts and src/lib/agents/embeddings.ts).
 *
 * The `embedding` field is a Firestore VectorValue, written out-of-band by the
 * ingestion worker via `FieldValue.vector([...])` — it is NOT a plain array, so
 * it is typed `unknown` here and excluded from the create-input schema (the
 * worker sets it directly, like email_jobs sets server timestamps).
 */
export const KnowledgeChunkSource = z.enum([
  "docs_url", // a documentation / web page (optionally shallow-crawled)
  "website", // a live marketing/site page
  "github", // a GitHub repository (shallow clone)
  "gitlab", // a GitLab repository (shallow clone)
]);
export type KnowledgeChunkSource = z.infer<typeof KnowledgeChunkSource>;

/** The native-vector embedding model + dimensionality the pipeline standardises on. */
export const EMBEDDING_MODEL = "text-embedding-005" as const;
export const EMBEDDING_DIM = 768 as const;

export const KnowledgeChunkSchema = z.object({
  /** Document id. Deterministic (`${ticketId}__${chunkIndex}`) so re-ingest overwrites. */
  id: z.string(),
  /** Stamped from the verified context — defence in depth + collection-group/BQ partition. */
  tenantId: z.string(),
  /** Redundant with the parent path; aids collection-group queries + the (deferred) BQ export. */
  campaignId: z.string(),
  /** The ingestion ticket that produced this chunk (provenance + bulk cleanup on re-ingest). */
  ticketId: z.string(),
  source: KnowledgeChunkSource,
  /** Repo URL or page URL the chunk came from. */
  sourceUri: z.string(),
  /** Section/file title — fed to the embedding model as RETRIEVAL_DOCUMENT `title` + shown in citations. */
  title: z.string(),
  /** File path within a repo, or the URL path for a page (null when not applicable). */
  path: z.string().nullable().optional(),
  /** Nearest `##`/`###` heading carried for citation context (null for code-only chunks). */
  heading: z.string().nullable().optional(),
  /** The chunk markdown — what we embed and return to the agents. */
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  /** 0-based order within the source, used to build the deterministic id. */
  chunkIndex: z.number().int().nonnegative(),
  embeddingModel: z.literal(EMBEDDING_MODEL),
  embeddingDim: z.literal(EMBEDDING_DIM),
  /** Firestore VectorValue set via FieldValue.vector([...]); not a plain array. */
  embedding: z.unknown(),
  createdAt: z.string(),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;
