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
  /** How the tenant was established, for auditing. */
  source: "host" | "idtoken" | "system";
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
