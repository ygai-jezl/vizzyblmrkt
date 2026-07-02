import { getDb, isAlreadyExists } from "./firestore";
import { databaseIdForRegion } from "./region";
import { TenantIsolationError, TenantValidationError } from "./errors";
import type {
  FirestoreLike,
  OrderDir,
  QueryLike,
  TenantContext,
  WhereOp,
} from "./types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import type { TenantUser } from "@/lib/types/tenantUser";
import type { Broadcast } from "@/lib/types/broadcast";
import type { Journey } from "@/lib/types/journey";
import type { EmailJob } from "@/lib/types/emailJob";
import type { EmailEvent } from "@/lib/types/emailEvent";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";
import type { Workspace } from "@/lib/types/workspace";
import type { ScheduledPost } from "@/lib/types/scheduledPost";

/** The reserved partition field present on every tenant-scoped document. */
export const TENANT_FIELD = "tenantId" as const;

export type WhereClause = [field: string, op: WhereOp, value: unknown];

export interface FindOptions {
  where?: WhereClause[];
  orderBy?: Array<[field: string, dir: OrderDir]>;
  limit?: number;
  /**
   * Cursor for keyset pagination — the order-field values of the last row of the
   * previous page (aligned to `orderBy`). Prefer this over an offset for the CRM
   * lists. Add an `id`/`createdAt` tiebreak to `orderBy` to disambiguate ties.
   */
  startAfter?: unknown[];
}

type TenantScoped = { tenantId: string; id: string };
type CreateInput<T extends TenantScoped> = Omit<T, "tenantId" | "id">;

/**
 * A tenant-scoped view of a single Firestore collection. EVERY operation is
 * forced through the tenant predicate:
 *
 *  - find/count always inject `where(tenantId == ctx.tenantId)` and ignore any
 *    caller attempt to override the tenant filter.
 *  - getById re-checks the stored document's tenantId (defence in depth against
 *    an id guessed from another tenant).
 *  - create strips any caller-supplied tenantId/id and stamps the trusted one.
 *  - update/delete verify tenant ownership before mutating, and refuse to change
 *    the tenantId.
 *
 * This is the platform's #1 security control. See docs/ARCHITECTURE-AND-DELIVERY.md §4.
 */
export class TenantCollection<T extends TenantScoped> {
  constructor(
    private readonly db: FirestoreLike,
    private readonly name: string,
    private readonly tenantId: string,
  ) {}

  /** Base query, already partitioned to this tenant. */
  private base(): QueryLike {
    return this.db
      .collection(this.name)
      .where(TENANT_FIELD, "==", this.tenantId);
  }

  private applyWhere(q: QueryLike, where: WhereClause[] = []): QueryLike {
    for (const [field, op, value] of where) {
      // The tenant predicate is non-negotiable. Silently drop any attempt to
      // re-filter (or widen) the tenant field.
      if (field === TENANT_FIELD) continue;
      q = q.where(field, op, value);
    }
    return q;
  }

  async find(opts: FindOptions = {}): Promise<T[]> {
    let q = this.applyWhere(this.base(), opts.where);
    for (const [field, dir] of opts.orderBy ?? []) q = q.orderBy(field, dir);
    if (opts.startAfter != null) q = q.startAfter(...opts.startAfter);
    if (opts.limit != null) q = q.limit(opts.limit);
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
  }

  /**
   * Aggregation count. Cheap per call (1 read per 1000 index entries) but it
   * scales with dataset size and needs a matching composite index. Do NOT use
   * it per-request on hot public paths (e.g. live leaderboard rank) — cache or
   * denormalise into a counter instead. See docs/ARCHITECTURE-AND-DELIVERY.md §6.
   */
  async count(where: WhereClause[] = []): Promise<number> {
    const q = this.applyWhere(this.base(), where);
    const snap = await q.count().get();
    return snap.data().count;
  }

  async getById(id: string): Promise<T | null> {
    const snap = await this.db.collection(this.name).doc(id).get();
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    // Defence in depth: a direct id fetch must still belong to this tenant.
    if (data[TENANT_FIELD] !== this.tenantId) return null;
    return { id: snap.id, ...data } as T;
  }

  /**
   * Create a document with a caller-provided id (use a UUID for signups, a slug
   * for campaigns). The tenantId is stamped from context — any tenantId/id in
   * `data` is ignored.
   *
   * SECURITY: uses Firestore's ATOMIC create(), which rejects if the id already
   * exists — in ANY tenant. We cannot pre-check with getById() (it is
   * tenant-scoped and would report a foreign-tenant document as absent, letting
   * a guessed id silently overwrite and re-home another tenant's record).
   * A collision surfaces as TenantIsolationError; callers that need
   * idempotent retries should handle it explicitly.
   */
  async create(id: string, data: CreateInput<T>): Promise<T> {
    if (!id) throw new TenantValidationError("create() requires a document id");
    const { tenantId: _t, id: _i, ...rest } = data as Record<string, unknown>;
    const doc = { ...rest, [TENANT_FIELD]: this.tenantId };
    try {
      await this.db.collection(this.name).doc(id).create(doc);
    } catch (err) {
      if (isAlreadyExists(err)) {
        throw new TenantIsolationError(
          `${this.name}/${id} already exists; refusing to overwrite`,
        );
      }
      throw err;
    }
    return { id, ...doc } as unknown as T;
  }

  async update(
    id: string,
    patch: Partial<CreateInput<T>>,
  ): Promise<void> {
    const existing = await this.getById(id); // verifies tenant ownership
    if (!existing) {
      throw new TenantIsolationError(
        `${this.name}/${id} not found in tenant ${this.tenantId}`,
      );
    }
    // Identity/immutable fields are defended HERE (not just by callers' schemas):
    // tenantId/id can never be re-homed, and createdAt can never be rewritten,
    // regardless of what a caller passes in the patch.
    const {
      tenantId: _t,
      id: _i,
      createdAt: _c,
      ...rest
    } = patch as Record<string, unknown>;
    await this.db.collection(this.name).doc(id).update(rest);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.getById(id); // verifies tenant ownership
    if (!existing) {
      throw new TenantIsolationError(
        `${this.name}/${id} not found in tenant ${this.tenantId}`,
      );
    }
    await this.db.collection(this.name).doc(id).delete();
  }

  /**
   * Hard-delete EVERY document in this tenant matching `where`, in bounded
   * pages, and return the number removed. The tenant predicate is always
   * applied (a bulk delete can never escape this tenant), and any caller attempt
   * to re-filter the tenant field is dropped — same guarantee as find().
   *
   * Pagination re-queries with a `limit` until a page comes back empty: deleted
   * docs drop out of the next query's result, so no cursor/startAfter is needed
   * (works identically against firebase-admin and the in-memory fake). Each page
   * is deleted by id directly — the query already proved tenant ownership, so a
   * per-doc getById re-check would only burn reads on a destructive bulk purge.
   *
   * Intended for irreversible cleanup (purging a launch's children), NOT a hot
   * path. `maxPages` is a runaway backstop, not an expected limit.
   */
  async deleteWhere(
    where: WhereClause[],
    opts: { pageSize?: number; maxPages?: number } = {},
  ): Promise<number> {
    const pageSize = opts.pageSize ?? 200;
    const maxPages = opts.maxPages ?? 100_000;
    let total = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const snap = await this.applyWhere(this.base(), where).limit(pageSize).get();
      if (snap.empty) break;
      await Promise.all(
        snap.docs.map((d) => this.db.collection(this.name).doc(d.id).delete()),
      );
      total += snap.docs.length;
      if (snap.docs.length < pageSize) break; // last (partial) page
    }
    return total;
  }
}

/** The set of tenant-scoped repositories available within a request context. */
export interface TenantRepositories {
  campaigns: TenantCollection<Campaign>;
  signups: TenantCollection<Signup>;
  members: TenantCollection<TenantUser>;
  /** Email hub: one-off broadcasts, journey graphs, and the delivery queue. */
  broadcasts: TenantCollection<Broadcast>;
  journeys: TenantCollection<Journey>;
  emailJobs: TenantCollection<EmailJob>;
  /** Per-recipient engagement events (opens/clicks/...) from Mandrill webhooks. */
  emailEvents: TenantCollection<EmailEvent>;
  /** Unified CRM: person records + company intelligence. Email history is read
   *  from `emailEvents` (the Mandrill-webhook engagement stream), keyed by signupId. */
  contacts: TenantCollection<Contact>;
  companies: TenantCollection<Company>;
  /** Knowledge ingestion: durable per-run status tickets. The chunks they
   *  produce live in the {campaigns|workspaces}/{id}/knowledge_bases subcollection
   *  (see src/lib/tenant/knowledge.ts) — not a TenantCollection. */
  ingestionTickets: TenantCollection<IngestionTicket>;
  /** Content OS: top-level workspaces (each owns a knowledge base). */
  workspaces: TenantCollection<Workspace>;
  /** Distribute: the scheduled-post queue (mirrors emailJobs; drained by the
   *  distribute worker/cron). Each doc is both content payload + queue job. */
  scheduledPosts: TenantCollection<ScheduledPost>;
}

/**
 * Entry point for all tenant-scoped data access. Pass a request's
 * TenantContext; receive repositories that can only ever see this tenant's
 * data.
 *
 * Residency routing: `campaigns` and `signups` (the PII) live in the tenant's
 * REGIONAL database (selected from ctx.region); `tenant_users` (membership
 * metadata, no end-user PII) stays in the control-plane (default) database
 * alongside the `tenants` registry. In tests, inject a fake Firestore as the
 * second argument — it backs every collection.
 */
export function forTenant(
  ctx: TenantContext,
  db?: FirestoreLike,
): TenantRepositories {
  if (!ctx?.tenantId) {
    throw new TenantValidationError("TenantContext.tenantId is required");
  }
  if (!ctx.region) {
    // Non-defaulting on purpose: a silent default would write a tenant's data
    // into the wrong region's database and break residency invisibly.
    throw new TenantValidationError("TenantContext.region is required");
  }
  const regionalDb =
    db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
  const controlDb = db ?? (getDb() as unknown as FirestoreLike);
  const t = ctx.tenantId;
  return {
    campaigns: new TenantCollection<Campaign>(regionalDb, "campaigns", t),
    signups: new TenantCollection<Signup>(regionalDb, "signups", t),
    members: new TenantCollection<TenantUser>(controlDb, "tenant_users", t),
    // Email-hub data is campaign/marketing PII → regional DB, like signups.
    broadcasts: new TenantCollection<Broadcast>(regionalDb, "broadcasts", t),
    journeys: new TenantCollection<Journey>(regionalDb, "journeys", t),
    emailJobs: new TenantCollection<EmailJob>(regionalDb, "email_jobs", t),
    emailEvents: new TenantCollection<EmailEvent>(regionalDb, "email_events", t),
    // Unified CRM PII → regional DB, like signups.
    contacts: new TenantCollection<Contact>(regionalDb, "contacts", t),
    companies: new TenantCollection<Company>(regionalDb, "companies", t),
    // Knowledge ingestion status tickets → regional DB (chunks live alongside,
    // in the campaigns/{id}/knowledge_bases subcollection).
    ingestionTickets: new TenantCollection<IngestionTicket>(
      regionalDb,
      "ingestion_tickets",
      t,
    ),
    workspaces: new TenantCollection<Workspace>(regionalDb, "workspaces", t),
    // Distribute queue: marketing content + scheduling metadata → regional DB,
    // like broadcasts/emailJobs.
    scheduledPosts: new TenantCollection<ScheduledPost>(
      regionalDb,
      "campaign_scheduled_posts",
      t,
    ),
  };
}
