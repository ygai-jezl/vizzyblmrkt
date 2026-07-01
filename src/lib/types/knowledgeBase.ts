import { z } from "zod";

/**
 * A semantically-chunked, vector-embedded knowledge snippet, ingested from an
 * external source (docs URL, live site, or a GitHub/GitLab repo) and used to
 * GROUND the AI agents via Firestore native vector search (`.findNearest()`).
 *
 * Knowledge ownership is POLYMORPHIC — a chunk belongs to either a campaign or a
 * workspace, stored as a subcollection under its owner:
 *   {campaigns|workspaces}/{ownerId}/knowledge_bases/{chunkId}
 * in the tenant's REGIONAL database (residency: chunk text never leaves its region).
 *
 * `embedding` is a Firestore VectorValue (written via `FieldValue.vector([...])`).
 * `topic` (a Content Matrix topic id) + `tags` (free-form) are queryable pre-filters.
 */
export const KnowledgeChunkSource = z.enum([
  "docs_url",
  "website",
  "github",
  "gitlab",
]);
export type KnowledgeChunkSource = z.infer<typeof KnowledgeChunkSource>;

/** What a knowledge base is attached to. */
export const KnowledgeOwnerKind = z.enum(["campaign", "workspace"]);
export type KnowledgeOwnerKind = z.infer<typeof KnowledgeOwnerKind>;

/**
 * PINNED source of truth for the embedding model + its vector dimension. NOT
 * env-overridable by design: the model id is coupled to the Firestore vector index
 * dimension (768), stamped via `z.literal` onto every stored KnowledgeChunk
 * (below), and baked into every already-embedded document across the regional DBs.
 * Changing it is a deliberate re-embedding migration (new model + re-embed the
 * corpus + rebuild the vector indexes), never a config flip. The isolated worker
 * keeps a mirrored copy (workers/knowledge-scraper/src/embed.ts) guarded by
 * src/lib/types/embeddingModelSync.test.ts. Generative (env-overridable) model ids
 * live in src/lib/agents/modelConfig.ts instead.
 */
export const EMBEDDING_MODEL = "text-embedding-005" as const;
export const EMBEDDING_DIM = 768 as const;

export const KnowledgeChunkSchema = z.object({
  /** Deterministic (`${ticketId}__${chunkIndex}`) so re-ingest overwrites. */
  id: z.string(),
  tenantId: z.string(),
  /** Polymorphic owner (campaign or workspace) — the subcollection parent. */
  ownerKind: KnowledgeOwnerKind,
  ownerId: z.string(),
  /** The ingestion ticket that produced this chunk. */
  ticketId: z.string(),
  source: KnowledgeChunkSource,
  sourceUri: z.string(),
  title: z.string(),
  path: z.string().nullable().optional(),
  heading: z.string().nullable().optional(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  chunkIndex: z.number().int().nonnegative(),
  /** Content Matrix topic id (OPTIONAL) — queryable pre-filter when set. */
  topic: z.string().nullable().default(null),
  /** Free-form custom tags (normalized) — queryable pre-filter (array-contains). */
  tags: z.array(z.string()),
  embeddingModel: z.literal(EMBEDDING_MODEL),
  embeddingDim: z.literal(EMBEDDING_DIM),
  /** Firestore VectorValue set via FieldValue.vector([...]); not a plain array. */
  embedding: z.unknown(),
  createdAt: z.string(),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;
