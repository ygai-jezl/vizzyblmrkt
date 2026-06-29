import type { TenantRole } from "@/lib/types/tenantUser";
import type { Region } from "@/lib/types/tenant";

/**
 * The verified identity a request operates under. CRITICAL: `tenantId` and
 * `region` are always derived server-side — from the verified host→tenant
 * mapping (public endpoints) or a verified ID-token claim (admin portal). They
 * must NEVER be taken from a request body or query string.
 */
export interface TenantContext {
  tenantId: string;
  /** Data-residency region — selects the regional Firestore database. */
  region: Region;
  userId?: string;
  role?: TenantRole;
  /**
   * The verified admin's email + whether the provider verified it. Carried from
   * the session cookie for the domain-ownership email-match fast-path (see
   * src/lib/domains/ownership.ts). Present only on admin (idtoken) contexts.
   */
  email?: string;
  emailVerified?: boolean;
  /**
   * How the tenant was established, for auditing. `agent` = reconstructed from a
   * signed capability token minted by the verified admin-chat proxy and echoed
   * back by an agent tool (see src/lib/canvas/auth.ts).
   */
  source: "host" | "tenant_param" | "idtoken" | "system" | "agent";
}

/**
 * A minimal STRUCTURAL view of the Firestore API surface this layer consumes.
 * The real firebase-admin `Firestore` satisfies it at runtime; tests inject an
 * in-memory fake that implements exactly this interface — so the isolation
 * invariants are proven without a live database.
 */
export type WhereOp =
  | "<"
  | "<="
  | "=="
  | "!="
  | ">="
  | ">"
  | "array-contains"
  | "in"
  | "array-contains-any"
  | "not-in";
export type OrderDir = "asc" | "desc";

export interface DocSnapLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}
export interface QueryDocLike {
  readonly id: string;
  data(): Record<string, unknown>;
}
export interface QuerySnapLike {
  readonly empty: boolean;
  readonly size: number;
  readonly docs: QueryDocLike[];
}
export interface AggregateSnapLike {
  data(): { count: number };
}
export interface AggregateQueryLike {
  get(): Promise<AggregateSnapLike>;
}
export interface QueryLike {
  where(field: string, op: WhereOp, value: unknown): QueryLike;
  orderBy(field: string, dir?: OrderDir): QueryLike;
  limit(n: number): QueryLike;
  /** Cursor pagination: values aligned to the active orderBy() fields. */
  startAfter(...values: unknown[]): QueryLike;
  get(): Promise<QuerySnapLike>;
  count(): AggregateQueryLike;
}
export interface DocRefLike {
  readonly id: string;
  get(): Promise<DocSnapLike>;
  /** Atomic create — rejects with ALREADY_EXISTS if the document already exists. */
  create(data: Record<string, unknown>): Promise<unknown>;
  set(data: Record<string, unknown>): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}
export interface CollectionLike extends QueryLike {
  doc(id?: string): DocRefLike;
}
export interface FirestoreLike {
  collection(name: string): CollectionLike;
}

// ── Vector search (knowledge_bases subcollection) ────────────────────────────
// A minimal STRUCTURAL view of Firestore's native vector-search surface. The
// real CollectionReference.findNearest(...) satisfies it; tests inject a fake
// that returns a controlled snapshot. Kept separate from FirestoreLike because
// vector search only applies to the knowledge_bases subcollection and the fake
// used by the isolation suite does not model it.
export type VectorDistanceMeasure = "COSINE" | "EUCLIDEAN" | "DOT_PRODUCT";
export interface VectorQueryOptionsLike {
  /** Document field holding the FieldValue.vector() embedding. */
  vectorField: string;
  /** The query embedding to find neighbours of. */
  queryVector: number[];
  limit: number;
  distanceMeasure: VectorDistanceMeasure;
  /** Optional output field the computed distance is written into on each result. */
  distanceResultField?: string;
  /** Optional max distance — neighbours beyond it are dropped. */
  distanceThreshold?: number;
}
export interface VectorQueryLike {
  get(): Promise<QuerySnapLike>;
}
/** A collection reference that supports a K-nearest-neighbour vector query. */
export interface KnowledgeCollectionLike {
  findNearest(opts: VectorQueryOptionsLike): VectorQueryLike;
}
