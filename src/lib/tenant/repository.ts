import { getDb, isAlreadyExists, isNotFound } from "./firestore";
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
import type { EmailSend } from "@/lib/types/emailSend";
import type { ProductEventDay, WidgetViewDay } from "@/lib/types/dailyCounts";
import type { EmailSuppression } from "@/lib/types/emailSuppression";
import type { Contact } from "@/lib/types/contact";
import type { Company } from "@/lib/types/company";
import type { IngestionTicket } from "@/lib/types/ingestionTicket";
import type { Workspace } from "@/lib/types/workspace";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import type { SocialEvent } from "@/lib/types/socialEvent";
import type { EngagedContact } from "@/lib/types/engagedContact";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { BrandLogo } from "@/lib/types/brandLogo";
import type { BrandFont } from "@/lib/types/brandFont";
import type { BrandAsset } from "@/lib/types/brandAsset";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";
import type { CatalogRevision } from "@/lib/types/catalogRevision";
import type { ProductUser } from "@/lib/types/productUser";
import type { ProductEvent, ConnectionDiagnostics } from "@/lib/types/productEvent";
import type {
  AiDraft,
  LifecycleJourney,
  LifecycleVersion,
  LifecycleEnrolment,
  WaitlistEnrolment,
  LifecycleWebhook,
  LifecycleCounter,
} from "@/lib/types/lifecycle";
import type { Invite, InviteWave } from "@/lib/types/invite";
import type { PersonPlan } from "@/lib/types/personPlan";
import type { PersonMove } from "@/lib/types/personMove";
import type { BrandMapRecord } from "@/lib/types/brandMap";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import type { BrandMapStoredRecord } from "@/lib/types/brandMapRecords";
import type { BrandAuthor } from "@/lib/types/brandAuthor";
import type { BrandNote } from "@/lib/types/brandNote";
import type { SiteKey } from "@/lib/types/siteKey";
import type { Competitor, CompetitorArticle, CompetitorChange, CompetitorPagesChunk, CompetitorPost } from "@/lib/types/competitor";
import type { BrandSignal } from "@/lib/types/brandSignal";
import type { AutopilotRun, LearnedEntry, NextUpDoc } from "@/lib/types/autopilot";
import type { LiveWatchDoc, LiveWatchSeen } from "@/lib/types/liveWatch";
import type { StoredEvent } from "@/lib/types/ontologyEvent";
import type { AgentAction } from "@/lib/types/agentAction";
import type { SettingsVersion } from "@/lib/types/settingsVersion";
import type { RecordFieldListDoc } from "@/lib/types/recordField";
import type { DataConnection, DataConnectionActivity } from "@/lib/types/dataConnection";

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

  /**
   * Atomically claim a document for exclusive processing. Inside a Firestore
   * transaction, reads the FRESHEST state and runs `plan(current)`: a returned patch
   * is applied and the updated doc returned; `null` declines the claim (returns null).
   *
   * This is the exactly-once primitive for the delivery/scheduler workers: under
   * overlapping cron runs only ONE transaction commits the pending→processing
   * transition; every racing worker re-reads `processing` inside its own transaction
   * and declines — so no external side-effect (e.g. a tweet with no idempotency key)
   * fires twice. Tenant ownership is re-verified inside the transaction, and the
   * identity/immutable fields (tenantId/id/createdAt) are stripped from the patch,
   * exactly as `update()` does.
   */
  async claim(
    id: string,
    plan: (current: T) => Partial<CreateInput<T>> | null,
  ): Promise<T | null> {
    const ref = this.db.collection(this.name).doc(id);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return null;
      const data = snap.data() ?? {};
      // Defence in depth: a guessed foreign-tenant id is invisible, never claimable.
      if (data[TENANT_FIELD] !== this.tenantId) return null;
      const current = { id: snap.id, ...data } as T;
      const patch = plan(current);
      if (!patch) return null;
      const {
        tenantId: _t,
        id: _i,
        createdAt: _c,
        ...rest
      } = patch as Record<string, unknown>;
      txn.update(ref, rest);
      return { ...current, ...rest } as T;
    });
  }

  /**
   * Atomically create-or-update a document with a caller-provided id. Inside a
   * transaction: if the id is free, `create()` supplies the new document; if it
   * exists in THIS tenant, `mutate(current)` returns a patch (or null to leave it
   * unchanged). Racing upserts serialise — a concurrent create is seen on retry
   * and takes the update path.
   *
   * SECURITY: like create(), an id that exists in ANOTHER tenant throws
   * TenantIsolationError — it is never overwritten or re-homed. Identity fields
   * (tenantId/id) are stamped/stripped, and createdAt is never rewritten on update.
   */
  async upsert(
    id: string,
    create: () => CreateInput<T>,
    mutate: (current: T) => Partial<CreateInput<T>> | null,
  ): Promise<{ doc: T; created: boolean }> {
    if (!id) throw new TenantValidationError("upsert() requires a document id");
    const ref = this.db.collection(this.name).doc(id);
    return this.db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) {
        const { tenantId: _t, id: _i, ...rest } = create() as Record<string, unknown>;
        const doc = { ...rest, [TENANT_FIELD]: this.tenantId };
        txn.create(ref, doc);
        return { doc: { id, ...doc } as unknown as T, created: true };
      }
      const data = snap.data() ?? {};
      if (data[TENANT_FIELD] !== this.tenantId) {
        throw new TenantIsolationError(
          `${this.name}/${id} already exists; refusing to overwrite`,
        );
      }
      const current = { id: snap.id, ...data } as T;
      const patch = mutate(current);
      if (!patch) return { doc: current, created: false };
      const {
        tenantId: _t,
        id: _i,
        createdAt: _c,
        ...rest
      } = patch as Record<string, unknown>;
      txn.update(ref, rest);
      return { doc: { ...current, ...rest } as T, created: false };
    });
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

  /**
   * Update ONE page of this tenant's documents matching `where`, ordered by document id: each row
   * goes through `plan(row)`, and a returned patch is written to that row (null leaves it alone).
   * Pass the result's `last` back as `startAfter` for the next page while `more` is true. Safe to
   * stop between pages and resume later from a stored `last`.
   *
   * SECURITY: the tenant predicate is always applied and any tenantId clause in `where` is
   * dropped, as in find(). Rows are written by id with no second read, because the query already
   * proved tenant ownership (the deleteWhere precedent); each row's tenantId is still checked
   * from the data the query returned. tenantId, id and createdAt are stripped from every patch,
   * as update() does. A row deleted between the read and the write (a time to live, an erase) is
   * counted as gone and never created again: update() refuses a missing document.
   *
   * Not a transaction or a batch: one row that expired would fail the whole write. With `dryRun`
   * it plans and counts, writing nothing.
   */
  async updateWhere(
    where: WhereClause[],
    plan: (row: T) => UpdatePatch<T> | null | Promise<UpdatePatch<T> | null>,
    opts: { startAfter?: string | null; limit: number; dryRun?: boolean },
  ): Promise<UpdateWhereResult> {
    let q = this.applyWhere(this.base(), where).orderBy("__name__", "asc");
    if (opts.startAfter) q = q.startAfter(opts.startAfter);
    const snap = await q.limit(opts.limit).get();
    const writes: Array<[id: string, patch: Record<string, unknown>]> = [];
    let unchanged = 0;
    for (const d of snap.docs) {
      const data = d.data() ?? {};
      if (data[TENANT_FIELD] !== this.tenantId) continue; // defence in depth
      const patch = await plan({ id: d.id, ...data } as T);
      const {
        tenantId: _t,
        id: _i,
        createdAt: _c,
        ...rest
      } = (patch ?? {}) as Record<string, unknown>;
      if (!patch || Object.keys(rest).length === 0) unchanged += 1;
      else writes.push([d.id, rest]);
    }
    let gone = 0;
    if (!opts.dryRun) {
      const results = await Promise.allSettled(
        writes.map(([id, rest]) => this.db.collection(this.name).doc(id).update(rest)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") continue;
        if (isNotFound(r.reason)) gone += 1;
        else throw r.reason;
      }
    }
    const docs = snap.docs;
    return {
      scanned: docs.length,
      updated: writes.length - gone,
      unchanged,
      gone,
      last: docs.length ? docs[docs.length - 1]!.id : (opts.startAfter ?? null),
      more: docs.length === opts.limit,
    };
  }
}

/** A patch updateWhere may write. Identity fields are stripped whatever the plan returns. */
export type UpdatePatch<T extends TenantScoped> = Partial<CreateInput<T>>;

/** What one updateWhere page did. In a dry run, `updated` counts the rows it would write. */
export interface UpdateWhereResult {
  /** Rows the query returned. */
  scanned: number;
  updated: number;
  /** Rows the plan left alone. */
  unchanged: number;
  /** Rows deleted between the read and the write: counted, never created again. */
  gone: number;
  /** The last row's id, the next page's startAfter (the given one when the page was empty). */
  last: string | null;
  /** True when the page was full, so there may be more. */
  more: boolean;
}

/**
 * The event history's and agent actions' view through forTenant: reads, and the erase's paged
 * delete. No create, update, upsert, claim or single delete, so a write that skips their writers
 * (./ontologyEvents.ts and ./agentActions.ts, which write inside transactions) fails typecheck,
 * however the store is reached. src/lib/ontology/appendOnly.test.ts keeps deleteWhere to the
 * writers.
 */
export type HistoryCollection<T extends TenantScoped> = Pick<TenantCollection<T>, "find" | "getById" | "count" | "deleteWhere">;

/**
 * The settings log's view through forTenant: reads only. Versions are created by
 * commitSettingsChange (./settingsLog.ts) in one transaction with their setting, and never
 * changed or deleted, so any other write fails typecheck however the store is reached.
 */
export type VersionCollection<T extends TenantScoped> = Pick<TenantCollection<T>, "find" | "getById" | "count">;

/**
 * Connected data's records through forTenant: reads only. A connection and the activity that
 * records each change are written together by ./dataConnections.ts, its only writer.
 */
export type ConnectionRecords<T extends TenantScoped> = Pick<TenantCollection<T>, "find" | "getById" | "count">;

/** Connected data's activity log through forTenant: a count only. The app writes it and never queries it. */
export type ActivityLog<T extends TenantScoped> = Pick<TenantCollection<T>, "count">;

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
  /** One record per email sent: its attribution (from a short Mandrill id) and, with
   *  EMAIL_ENGAGEMENT_DETAIL_ENABLED, every open, click and bounce detail. Personal data. */
  emailSends: TenantCollection<EmailSend>;
  /** Widget views per launch per day, sharded, kept forever (WIDGET_VIEW_COUNTS_ENABLED). No person. */
  widgetViewDays: TenantCollection<WidgetViewDay>;
  /** Accepted product events per connection per day by name, sharded, kept after the events' TTL (PRODUCT_EVENT_DAYS_ENABLED). */
  productEventDays: TenantCollection<ProductEventDay>;
  /** Tenant-wide unsubscribe / spam / hard-bounce opt-outs (send-time suppression). */
  emailSuppressions: TenantCollection<EmailSuppression>;
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
  /** Distribute: inbound social engagement (replies/mentions/likes/DMs) ingested
   *  from the platform webhooks (mirrors emailEvents). Marketing PII → regional DB. */
  socialEvents: TenantCollection<SocialEvent>;
  /** CRM "Engaged" tab: distinct social profiles who engaged. Separate from
   *  `contacts` so scraped social identities never pollute the email CRM. */
  socialEngaged: TenantCollection<EngagedContact>;
  /** Brand Kit: registry of every AI-generated image across the tenant's workspaces.
   *  The bytes live in the private GCS bucket; each row carries the workspaceId +
   *  filename needed to serve them via the authenticated workspace-asset proxy. */
  imageAssets: TenantCollection<ImageAsset>;
  /** Brand Kit: the tenant's uploaded corporate logos (brand-global). Bytes live at the
   *  tenant-level GCS key `brand/{tenantId}/logos/...` and are served by the public
   *  /api/brand-logo proxy so the primary logo can render in recipient-facing emails. */
  logos: TenantCollection<BrandLogo>;
  /** Brand Kit: uploaded custom FONT FILES (brand-global). Bytes live at `brand/{tenantId}/fonts/...`
   *  and are served by the public /api/brand-font proxy for in-app @font-face preview. */
  brandFonts: TenantCollection<BrandFont>;
  /** Brand Kit: uploaded ICONS + GRAPHICS (brand-global, discriminated by `category`). Bytes live at
   *  `brand/{tenantId}/{category}s/...` and are served by the public /api/brand-asset proxy;
   *  also fed into image generation as visual references. */
  brandAssets: TenantCollection<BrandAsset>;
  /** Lifecycle: the tenant's connected products (keys, endpoints, catalog). */
  productConnections: TenantCollection<ProductConnection>;
  /** Lifecycle: "Learn from your repo" runs — a product map proposed from the customer's code (read-only). */
  repoAnalyses: TenantCollection<RepoAnalysis>;
  /** Lifecycle: the last few saved versions of each connection's catalog, for undo. */
  catalogRevisions: TenantCollection<CatalogRevision>;
  /** Lifecycle: the connected products' end users, built from ingested events. */
  productUsers: TenantCollection<ProductUser>;
  /** Lifecycle: the ingested identify/track log (idempotency gate + debugger). */
  productEvents: TenantCollection<ProductEvent>;
  /** Lifecycle: per-connection observed catalog + recent rejections. */
  connectionDiagnostics: TenantCollection<ConnectionDiagnostics>;
  /** Lifecycle journeys (draft) and their immutable published versions. */
  lifecycleJourneys: TenantCollection<LifecycleJourney>;
  lifecycleVersions: TenantCollection<LifecycleVersion>;
  /** Per-user journey progress — also the lifecycle runner's queue. */
  lifecycleEnrolments: TenantCollection<LifecycleEnrolment>;
  /** Waitlist journeys on the lifecycle engine: per-signup progress, in its own queue. */
  waitlistEnrolments: TenantCollection<WaitlistEnrolment>;
  /** Signed webhooks awaiting delivery to connected products. */
  lifecycleWebhooks: TenantCollection<LifecycleWebhook>;
  /** Exact daily send counters per journey. */
  lifecycleCounters: TenantCollection<LifecycleCounter>;
  /** Lifecycle: per-person AI lines awaiting (or past) staff approval. */
  lifecycleDrafts: TenantCollection<AiDraft>;
  /** Invite your waitlist (nav v2 phase 4): one invite per person per launch, and the waves that send them. */
  invites: TenantCollection<Invite>;
  inviteWaves: TenantCollection<InviteWave>;
  /** The person view: one plan per product user, drafted by Vizzy and approved by staff. */
  personPlans: TenantCollection<PersonPlan>;
  /** A product user who moved to another person (ONTOLOGY_PERSON_IDS_ENABLED), and whether their rows have followed. */
  personMoves: TenantCollection<PersonMove>;
  /** The brand map: one document per brand (`bm_<tenantId>`), parsed by src/lib/brandMap/store.ts. */
  brandMaps: TenantCollection<BrandMapRecord>;
  /** The brand map's pages: a row per article written here, and per page already on the site. */
  brandMapPages: TenantCollection<BrandMapPage>;
  /**
   * The brand map at any size: its groups, subjects, questions, buying situations, research
   * runs and imports, one document each. Reach them through brandMapRecords() in
   * ./brandMapRecords.ts, which keys each document by a digest of brand and record id.
   */
  brandMapGroups: TenantCollection<BrandMapStoredRecord>;
  brandMapSubjects: TenantCollection<BrandMapStoredRecord>;
  brandMapQuestions: TenantCollection<BrandMapStoredRecord>;
  brandMapSituations: TenantCollection<BrandMapStoredRecord>;
  brandMapRuns: TenantCollection<BrandMapStoredRecord>;
  brandMapImports: TenantCollection<BrandMapStoredRecord>;
  /** The authors a brand's articles are written under (role, bio, profile page), one per name. */
  brandAuthors: TenantCollection<BrandAuthor>;
  /** What we've seen: the brand's own first-hand notes (src/lib/brandNotes/store.ts). */
  brandNotes: TenantCollection<BrandNote>;
  /** A launch's site key, one per launch by launch id (src/lib/waitlist/siteKeys.ts). */
  siteKeys: TenantCollection<SiteKey>;
  /** Competitors a brand watches (src/lib/competitors/store.ts), with their sitemap's pages, posts and changes. */
  competitors: TenantCollection<Competitor>;
  competitorPages: TenantCollection<CompetitorPagesChunk>;
  competitorPosts: TenantCollection<CompetitorPost>;
  competitorChanges: TenantCollection<CompetitorChange>;
  /** Their articles read in full (COMPETITOR_ARTICLES_ENABLED): findings and short quotes, never the text. */
  competitorArticles: TenantCollection<CompetitorArticle>;
  /** Outside numbers about the brand (BRAND_SIGNALS_ENABLED): Google's results per question (src/lib/signals). */
  brandSignals: TenantCollection<BrandSignal>;
  /** What the autopilot learned from people's choices (src/lib/autopilot/learned.ts). */
  autopilotLearned: TenantCollection<LearnedEntry>;
  /** Next up: the brand's three best next articles, one doc per brand (src/lib/nextUp). */
  nextUp: TenantCollection<NextUpDoc>;
  /** Autopilot runs: one question found, sorted and (Draft mode) written (src/lib/autopilot/runs.ts). */
  autopilotRuns: TenantCollection<AutopilotRun>;
  /** Found live: when to look next and which addresses it checks (src/lib/content/blog/liveWatch.ts). */
  liveWatch: TenantCollection<LiveWatchDoc>;
  /** Found live: the brand's pages it already opened, hashed (src/lib/content/blog/liveWatch.ts). */
  liveWatchSeen: TenantCollection<LiveWatchSeen>;
  /**
   * The event history: one row per thing that happened to a person, company, idea or agent
   * action. Append only: written only through ./ontologyEvents.ts and ./agentActions.ts.
   */
  ontologyEvents: HistoryCollection<StoredEvent>;
  /** Agents' suggestions, one record each, with their agent.* trail in ontologyEvents (./agentActions.ts writes them). */
  agentActions: HistoryCollection<AgentAction>;
  /** The settings log: every version of a brand's settings, kept whole (./settingsLog.ts writes them). */
  settingsVersions: VersionCollection<SettingsVersion>;
  /**
   * The brand's People and Company field lists, one document each (AUDIENCE_FIELDS_ENABLED). Read
   * only here: a list changes only with its settings version (./settingsLog.ts).
   */
  recordFieldLists: VersionCollection<RecordFieldListDoc>;
  /** Connected data (CONNECTORS_ENABLED): one record per connection, its secrets sealed (./dataConnections.ts writes them). */
  dataConnections: ConnectionRecords<DataConnection>;
  /** Each change to a connection, kept 90 days by a TTL on ttlAt (./dataConnections.ts writes them). */
  dataConnectionActivity: ActivityLog<DataConnectionActivity>;
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
    emailSends: new TenantCollection<EmailSend>(regionalDb, "email_sends", t),
    widgetViewDays: new TenantCollection<WidgetViewDay>(regionalDb, "widget_view_days", t),
    productEventDays: new TenantCollection<ProductEventDay>(regionalDb, "product_event_days", t),
    // Opt-outs are keyed by email (marketing PII) → regional DB, like signups.
    emailSuppressions: new TenantCollection<EmailSuppression>(
      regionalDb,
      "email_suppressions",
      t,
    ),
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
    // Inbound social engagement PII → regional DB, like email_events.
    socialEvents: new TenantCollection<SocialEvent>(regionalDb, "social_events", t),
    socialEngaged: new TenantCollection<EngagedContact>(regionalDb, "social_engaged", t),
    // Brand Kit image registry: generated-content metadata (no end-user PII) →
    // regional DB, colocated with the workspaces/content it references.
    imageAssets: new TenantCollection<ImageAsset>(regionalDb, "image_assets", t),
    // Brand logos: brand-global metadata (no end-user PII) → regional DB, colocated with
    // the workspaces/content that reference them.
    logos: new TenantCollection<BrandLogo>(regionalDb, "brand_logos", t),
    // Brand fonts + assets: brand-global metadata (no end-user PII) → regional DB, colocated
    // with the workspaces/content that reference them, like logos.
    brandFonts: new TenantCollection<BrandFont>(regionalDb, "brand_fonts", t),
    brandAssets: new TenantCollection<BrandAsset>(regionalDb, "brand_assets", t),
    // Lifecycle: connected products and their end users' PII/events → regional DB,
    // like signups. The control-plane `connection_keys` lookup (no PII) lives in
    // src/lib/tenant/connectionKeys.ts.
    productConnections: new TenantCollection<ProductConnection>(
      regionalDb,
      "product_connections",
      t,
    ),
    repoAnalyses: new TenantCollection<RepoAnalysis>(regionalDb, "repo_analyses", t),
    catalogRevisions: new TenantCollection<CatalogRevision>(regionalDb, "catalog_revisions", t),
    productUsers: new TenantCollection<ProductUser>(regionalDb, "product_users", t),
    productEvents: new TenantCollection<ProductEvent>(regionalDb, "product_events", t),
    connectionDiagnostics: new TenantCollection<ConnectionDiagnostics>(
      regionalDb,
      "connection_diagnostics",
      t,
    ),
    // Lifecycle runtime: journeys, versions, enrolments (end-user progress = PII
    // adjacent), webhook queue and counters → regional DB, with the product users.
    lifecycleJourneys: new TenantCollection<LifecycleJourney>(regionalDb, "lifecycle_journeys", t),
    lifecycleVersions: new TenantCollection<LifecycleVersion>(regionalDb, "lifecycle_versions", t),
    lifecycleEnrolments: new TenantCollection<LifecycleEnrolment>(regionalDb, "lifecycle_enrolments", t),
    waitlistEnrolments: new TenantCollection<WaitlistEnrolment>(regionalDb, "waitlist_enrolments", t),
    lifecycleWebhooks: new TenantCollection<LifecycleWebhook>(regionalDb, "lifecycle_webhooks", t),
    lifecycleCounters: new TenantCollection<LifecycleCounter>(regionalDb, "lifecycle_counters", t),
    lifecycleDrafts: new TenantCollection<AiDraft>(regionalDb, "lifecycle_drafts", t),
    // Invites tie a signup to a product sign-up (marketing PII-adjacent: an email
    // hash, no address) → regional DB, like signups.
    invites: new TenantCollection<Invite>(regionalDb, "invites", t),
    inviteWaves: new TenantCollection<InviteWave>(regionalDb, "invite_waves", t),
    // A plan is about one end user (their situation, in staff's words) → regional DB, with the person.
    personPlans: new TenantCollection<PersonPlan>(regionalDb, "person_plans", t),
    // A move names a product user and two people (ids only, no address): end-user data → regional DB, with them.
    personMoves: new TenantCollection<PersonMove>(regionalDb, "person_moves", t),
    // The brand map sits with the content it steers (programmes and their plans) → regional DB.
    brandMaps: new TenantCollection<BrandMapRecord>(regionalDb, "brand_maps", t),
    brandMapPages: new TenantCollection<BrandMapPage>(regionalDb, "brand_map_pages", t),
    brandMapGroups: new TenantCollection<BrandMapStoredRecord>(regionalDb, "brand_map_groups", t),
    brandMapSubjects: new TenantCollection<BrandMapStoredRecord>(regionalDb, "brand_map_subjects", t),
    brandMapQuestions: new TenantCollection<BrandMapStoredRecord>(regionalDb, "brand_map_questions", t),
    brandMapSituations: new TenantCollection<BrandMapStoredRecord>(regionalDb, "brand_map_situations", t),
    brandMapRuns: new TenantCollection<BrandMapStoredRecord>(regionalDb, "brand_map_runs", t),
    brandMapImports: new TenantCollection<BrandMapStoredRecord>(regionalDb, "brand_map_imports", t),
    // An article's author (a person's name, role and bio) sits with the articles → regional DB.
    brandAuthors: new TenantCollection<BrandAuthor>(regionalDb, "brand_authors", t),
    // The brand's first-hand notes may name its customers → regional DB, with the content they inform.
    brandNotes: new TenantCollection<BrandNote>(regionalDb, "brand_notes", t),
    // A launch's site key (a sealed secret, no end-user PII) sits with its launch → regional DB.
    // The control-plane `launch_keys` lookup lives in src/lib/tenant/launchKeys.ts.
    siteKeys: new TenantCollection<SiteKey>(regionalDb, "launch_site_keys", t),
    // What a brand learns about its competitors (their public pages, no end-user PII) sits with
    // the content it informs → regional DB, like the brand map.
    competitors: new TenantCollection<Competitor>(regionalDb, "competitors", t),
    competitorPages: new TenantCollection<CompetitorPagesChunk>(regionalDb, "competitor_pages", t),
    competitorPosts: new TenantCollection<CompetitorPost>(regionalDb, "competitor_posts", t),
    competitorChanges: new TenantCollection<CompetitorChange>(regionalDb, "competitor_changes", t),
    competitorArticles: new TenantCollection<CompetitorArticle>(regionalDb, "competitor_articles", t),
    // Public search results for the brand's questions (no end-user PII) sit with the content they
    // inform → regional DB, like competitors and the brand map.
    brandSignals: new TenantCollection<BrandSignal>(regionalDb, "brand_signals", t),
    // What the brand's people kept, skipped and moved while planning: brand content → regional DB.
    autopilotLearned: new TenantCollection<LearnedEntry>(regionalDb, "autopilot_learned", t),
    nextUp: new TenantCollection<NextUpDoc>(regionalDb, "next_up", t),
    autopilotRuns: new TenantCollection<AutopilotRun>(regionalDb, "autopilot_runs", t),
    // Found live's working state about the brand's own site and articles: regional, beside them.
    liveWatch: new TenantCollection<LiveWatchDoc>(regionalDb, "live_watch", t),
    liveWatchSeen: new TenantCollection<LiveWatchSeen>(regionalDb, "live_watch_seen", t),
    // A person's history and agents' suggestions are personal: regional, beside the person.
    ontologyEvents: new TenantCollection<StoredEvent>(regionalDb, "ontology_events", t),
    agentActions: new TenantCollection<AgentAction>(regionalDb, "agent_actions", t),
    settingsVersions: new TenantCollection<SettingsVersion>(regionalDb, "settings_versions", t),
    recordFieldLists: new TenantCollection<RecordFieldListDoc>(regionalDb, "record_field_lists", t),
    // A connection holds a brand's sealed tokens and settings, kept in its region beside the data
    // it reads; its activity names team members by id only. Both regional, like launch_site_keys.
    dataConnections: new TenantCollection<DataConnection>(regionalDb, "data_connections", t),
    dataConnectionActivity: new TenantCollection<DataConnectionActivity>(regionalDb, "data_connection_activity", t),
  };
}
