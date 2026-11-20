import { getDb, isAlreadyExists } from "./firestore";
import { databaseIdForRegion } from "./region";
import { forTenant, TENANT_FIELD, type WhereClause } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import type { DocRefLike, FirestoreLike, QueryLike, TenantContext, TransactionLike } from "./types";
import { deterministicEventId } from "@/lib/crm/identifiers";
import { isAgentEventKind, isCanonicalInstant, subjectKey, USER_FIELD_ID } from "@/lib/ontology/events";
import { EVENT_LIMITS, EventWriteSchema, type EventId, type EventWrite, type StoredEvent } from "@/lib/types/ontologyEvent";
import type { AgentAction } from "@/lib/types/agentAction";
import type { Campaign } from "@/lib/types/campaign";
import type { Company } from "@/lib/types/company";
import type { Contact } from "@/lib/types/contact";

/**
 * The event history (ontology_events, the brand's regional database): its only writer, with
 * src/lib/tenant/agentActions.ts for the agent.* rows. Append only. A stored row changes in three
 * ways and no other:
 *  (a) its personId (and a person subject) is repointed to the person a product user belongs to now;
 *  (b) an erased field's values before and after are blanked in place;
 *  (c) it is deleted by an erase.
 *
 * Every write runs in a Firestore transaction in the brand's regional database, so a record's
 * change and its events commit together (a transaction cannot span databases: take the database
 * from regionalStoreFor). All reads come first: prepareEventsTx reads every event's ref and skips
 * keys already stored, and only its PreparedEvent values can be staged.
 *
 * The raw transaction helpers (regionalStoreFor, prepareEventsTx, stageEvent, stageAgentEventTx)
 * are for other modules in src/lib/tenant only and are not exported from @/lib/tenant, whose
 * functions all take a TenantContext.
 */

export const ONTOLOGY_EVENTS = "ontology_events";

/** The two history stores by repository key, so callers (0c's repoint job) never write a collection name. */
export const HISTORY_COLLECTIONS = { ontologyEvents: "ontology_events", agentActions: "agent_actions" } as const;
export type HistoryStore = keyof typeof HISTORY_COLLECTIONS;

/** The records whose change can commit with its events. */
export const EVENT_RECORD_COLLECTIONS = { contacts: "contacts", companies: "companies", campaigns: "campaigns" } as const;
export type RecordCollection = keyof typeof EVENT_RECORD_COLLECTIONS;

type RecordMap = { contacts: Contact; companies: Company; campaigns: Campaign };
export type RecordOf<C extends RecordCollection> = RecordMap[C];

// --- Internal helpers, for src/lib/tenant only ---------------------------------------------------

/** The brand's regional database: the one the history, the people, companies and launches share. */
export function regionalStoreFor(ctx: TenantContext, db?: FirestoreLike): FirestoreLike {
  return db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);
}

export function eventRef(store: FirestoreLike, tenantId: string, key: string): DocRefLike {
  return store.collection(ONTOLOGY_EVENTS).doc(deterministicEventId(tenantId, key));
}

declare const PREPARED: unique symbol;
/** A write checked and read in this transaction: the only thing stageEvent accepts. */
export type PreparedEvent = EventWrite & { readonly id: EventId; readonly [PREPARED]: true };

/** The write, checked: a bad one throws with the field and the rule, never the value. */
function parseWrite(write: EventWrite): EventWrite {
  const parsed = EventWriteSchema.safeParse(write);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TenantValidationError(`bad_event:${issue ? `${issue.path.join(".")}:${issue.message}` : "invalid"}`);
  }
  return parsed.data as EventWrite;
}

function nowOr(nowIso?: string): string {
  if (nowIso === undefined) return new Date().toISOString();
  if (!isCanonicalInstant(nowIso)) throw new TenantValidationError("nowIso must be canonical (toISOString)");
  return nowIso;
}

/**
 * The read phase: checks each write, reads every event's ref, and returns the ones not yet stored
 * (fresh) and the keys already stored in this brand (duplicates). A key stored for another brand
 * throws TenantIsolationError. Call it before any write in the transaction.
 */
export async function prepareEventsTx(
  txn: TransactionLike,
  store: FirestoreLike,
  ctx: TenantContext,
  writes: readonly EventWrite[],
): Promise<{ fresh: PreparedEvent[]; duplicates: string[] }> {
  const parsed = writes.map(parseWrite);
  const keys = new Set<string>();
  for (const w of parsed) {
    if (keys.has(w.key)) throw new TenantValidationError("the same event key twice in one write");
    keys.add(w.key);
  }
  const refs = parsed.map((w) => eventRef(store, ctx.tenantId, w.key));
  const snaps = await Promise.all(refs.map((ref) => txn.get(ref)));
  const fresh: PreparedEvent[] = [];
  const duplicates: string[] = [];
  snaps.forEach((snap, i) => {
    const w = parsed[i]!;
    if (snap.exists) {
      if ((snap.data() ?? {})[TENANT_FIELD] !== ctx.tenantId) {
        throw new TenantIsolationError(`${ONTOLOGY_EVENTS}/${refs[i]!.id} belongs to another tenant`);
      }
      duplicates.push(w.key);
    } else {
      fresh.push({ ...w, id: refs[i]!.id as EventId } as PreparedEvent);
    }
  });
  return { fresh, duplicates };
}

/** The row as stored: tenantId from the context (never the input), absent optionals as null. */
function stage(txn: TransactionLike, store: FirestoreLike, ctx: TenantContext, e: PreparedEvent, nowIso?: string): StoredEvent {
  const id = deterministicEventId(ctx.tenantId, e.key);
  if (id !== e.id) throw new TenantIsolationError("an event prepared for another brand");
  const row = {
    key: e.key,
    kind: e.kind,
    at: e.at,
    subject: { type: e.subject.type, id: e.subject.id },
    subjectKey: subjectKey(e.subject),
    personId: e.personId,
    productUserId: e.productUserId ?? null,
    fieldId: e.fieldId ?? null,
    agentActionId: e.agentActionId ?? null,
    identity: e.identity ?? null,
    ideaCredited: e.ideaCredited ?? null,
    source: e.source,
    actor: e.actor,
    refs: e.refs ?? null,
    properties: e.properties,
    createdAt: nowOr(nowIso),
    blankedAt: null,
    blankedReason: null,
    [TENANT_FIELD]: ctx.tenantId,
  };
  txn.create(store.collection(ONTOLOGY_EVENTS).doc(id), row);
  return { id, ...row } as StoredEvent;
}

/** The write phase, create only: one prepared event. Refuses agent.* kinds (agentActions.ts writes those). */
export function stageEvent(txn: TransactionLike, store: FirestoreLike, ctx: TenantContext, e: PreparedEvent, nowIso?: string): StoredEvent {
  if (isAgentEventKind(e.kind)) throw new TenantValidationError("agent.* events are written with their agent action");
  return stage(txn, store, ctx, e, nowIso);
}

/** The write phase for agent.* rows only. For src/lib/tenant/agentActions.ts alone (the append only guard checks). */
export function stageAgentEventTx(txn: TransactionLike, store: FirestoreLike, ctx: TenantContext, e: PreparedEvent, nowIso?: string): StoredEvent {
  if (!isAgentEventKind(e.kind)) throw new TenantValidationError("only agent.* events are staged here");
  return stage(txn, store, ctx, e, nowIso);
}

/** Runs a transaction, once more if a create raced another (the claimLifecycleSend pattern). */
export async function retryOnceOnExists<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (isAlreadyExists(err)) return attempt();
    throw err;
  }
}

// --- Appending ---------------------------------------------------------------------------------

/**
 * Append events in one transaction: up to 200, unique keys, no agent.* kinds. A key already
 * stored in this brand comes back in `duplicates` and is not written again, so a retried call
 * writes nothing twice.
 */
export async function appendEvents(
  ctx: TenantContext,
  writes: readonly EventWrite[],
  opts: { db?: FirestoreLike; nowIso?: string } = {},
): Promise<{ written: StoredEvent[]; duplicates: string[] }> {
  if (writes.length > EVENT_LIMITS.appendBatch) throw new TenantValidationError(`at most ${EVENT_LIMITS.appendBatch} events in one call`);
  if (writes.some((w) => isAgentEventKind(w.kind))) throw new TenantValidationError("agent.* events are written with their agent action");
  if (new Set(writes.map((w) => w.key)).size !== writes.length) throw new TenantValidationError("the same event key twice in one call");
  if (writes.length === 0) return { written: [], duplicates: [] };
  const store = regionalStoreFor(ctx, opts.db);
  const now = nowOr(opts.nowIso);
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn) => {
      const { fresh, duplicates } = await prepareEventsTx(txn, store, ctx, writes);
      return { written: fresh.map((e) => stageEvent(txn, store, ctx, e, now)), duplicates };
    }),
  );
}

// --- A record and its events, together ---------------------------------------------------------

/**
 * What a plan does with a record: create it (contacts only), patch it, refuse with a reason, or
 * nothing (null). Its events are written in the same commit. A plan is pure and may run more than
 * once (a transaction retries).
 */
export type RecordPlan<C extends RecordCollection> =
  | (C extends "contacts" ? { create: Omit<RecordOf<C>, "id" | "tenantId">; events: EventWrite[] } : never)
  | { patch: Partial<Omit<RecordOf<C>, "id" | "tenantId" | "createdAt">>; events: EventWrite[] }
  | { reject: string }
  | null;

export type RecordWriteResult<C extends RecordCollection> =
  | { outcome: "created" | "updated"; doc: RecordOf<C>; events: StoredEvent[]; agentAction: AgentAction | null }
  | { outcome: "unchanged"; doc: RecordOf<C> | null }
  | { outcome: "rejected"; reason: string };

/**
 * Change a contact, company or campaign and write its events in one transaction: read the record
 * (tenant checked), run the plan, read the events' refs, then write. Creates are for contacts
 * only: companies and launches keep their own create paths (createLaunch checks its slug and site
 * key). Outcomes: created, updated, unchanged (a null plan, or nothing to write), or rejected with
 * the plan's reason, "not_found" (a patch on nothing), "exists" (a create on something) or
 * "create_not_allowed". An event key already stored is skipped, not an error.
 */
export async function writeRecordWithEvents<C extends RecordCollection>(
  ctx: TenantContext,
  collection: C,
  id: string,
  plan: (current: RecordOf<C> | null, action: AgentAction | null) => RecordPlan<C>,
  opts: { db?: FirestoreLike; nowIso?: string } = {},
): Promise<RecordWriteResult<C>> {
  if (!Object.prototype.hasOwnProperty.call(EVENT_RECORD_COLLECTIONS, collection)) {
    throw new TenantValidationError("writeRecordWithEvents takes contacts, companies or campaigns");
  }
  if (!id) throw new TenantValidationError("writeRecordWithEvents needs a document id");
  const store = regionalStoreFor(ctx, opts.db);
  const ref = store.collection(EVENT_RECORD_COLLECTIONS[collection]).doc(id);
  const now = nowOr(opts.nowIso);
  return retryOnceOnExists(() =>
    store.runTransaction(async (txn): Promise<RecordWriteResult<C>> => {
      const snap = await txn.get(ref);
      let current: RecordOf<C> | null = null;
      if (snap.exists) {
        const data = snap.data() ?? {};
        if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${collection}/${id} belongs to another tenant`);
        current = { ...data, id: snap.id } as unknown as RecordOf<C>;
      }
      const p = plan(current, null) as RecordPlan<RecordCollection>;
      if (!p) return { outcome: "unchanged", doc: current };
      if ("reject" in p) return { outcome: "rejected", reason: p.reject };
      const events = p.events ?? [];
      if (events.length > EVENT_LIMITS.recordEvents) throw new TenantValidationError(`at most ${EVENT_LIMITS.recordEvents} events with one record`);
      if (events.some((e) => isAgentEventKind(e.kind))) throw new TenantValidationError("agent.* events are written with their agent action");
      if ("create" in p) {
        if (collection !== "contacts") return { outcome: "rejected", reason: "create_not_allowed" };
        if (current) return { outcome: "rejected", reason: "exists" };
      } else if (!current) {
        return { outcome: "rejected", reason: "not_found" };
      }
      // Still the read phase: every event's ref.
      const { fresh } = await prepareEventsTx(txn, store, ctx, events);

      let doc: RecordOf<C>;
      let outcome: "created" | "updated";
      if ("create" in p) {
        const { tenantId: _t, id: _i, ...rest } = p.create as Record<string, unknown>;
        const data = { ...rest, [TENANT_FIELD]: ctx.tenantId };
        txn.create(ref, data);
        doc = { ...data, id } as unknown as RecordOf<C>;
        outcome = "created";
      } else {
        // As TenantCollection.update: identity and createdAt are never rewritten.
        const { tenantId: _t, id: _i, createdAt: _c, ...rest } = p.patch as Record<string, unknown>;
        if (Object.keys(rest).length === 0 && fresh.length === 0) return { outcome: "unchanged", doc: current };
        if (Object.keys(rest).length > 0) txn.update(ref, rest);
        doc = { ...current, ...rest } as RecordOf<C>;
        outcome = "updated";
      }
      const written = fresh.map((e) => stageEvent(txn, store, ctx, e, now));
      return { outcome, doc, events: written, agentAction: null };
    }),
  );
}

// --- Blanking an erased field ------------------------------------------------------------------

export interface BlankResult {
  scanned: number;
  blanked: number;
  /** Rows blanked before (or, for actions, no longer holding the field). */
  already: number;
  /** Rows deleted between the page read and its transaction. */
  gone: number;
  /** The page's last id: the next page's startAfter. */
  last: string | null;
  more: boolean;
}

export interface BlankOptions {
  startAfter?: string | null;
  /** Default 200, at most 400. */
  limit?: number;
  dryRun?: boolean;
  nowIso: string;
  db?: FirestoreLike;
}

export const BLANK_PAGE = { default: 200, max: 400 } as const;

/** A history store's rows in this brand, a page at a time in document id order (pageBrandMapPages' pattern). */
export async function pageHistory(
  store: FirestoreLike,
  ctx: TenantContext,
  history: HistoryStore,
  opts: { where: WhereClause[]; fields?: string[]; after?: string | null; limit: number },
): Promise<{ rows: Array<{ id: string; data: Record<string, unknown> }>; last: string | null; more: boolean }> {
  let q: QueryLike = store.collection(HISTORY_COLLECTIONS[history]).where(TENANT_FIELD, "==", ctx.tenantId);
  for (const [field, op, value] of opts.where) if (field !== TENANT_FIELD) q = q.where(field, op, value);
  q = q.orderBy("__name__", "asc");
  if (opts.fields && q.select) q = q.select(...new Set([TENANT_FIELD, ...opts.fields]));
  if (opts.after) q = q.startAfter(opts.after);
  const snap = await q.limit(opts.limit).get();
  const rows: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const d of snap.docs) {
    const data = d.data() ?? {};
    if (data[TENANT_FIELD] !== ctx.tenantId) continue; // defence in depth
    rows.push({ id: d.id, data });
  }
  return { rows, last: snap.docs.length ? snap.docs[snap.docs.length - 1]!.id : (opts.after ?? null), more: snap.docs.length === opts.limit };
}

export function blankLimit(limit: number | undefined): number {
  const n = limit ?? BLANK_PAGE.default;
  if (!Number.isInteger(n) || n < 1) throw new TenantValidationError("limit must be a positive whole number");
  return Math.min(n, BLANK_PAGE.max);
}

export function checkUserFieldId(fieldId: string): void {
  if (typeof fieldId !== "string" || !USER_FIELD_ID.test(fieldId)) throw new TenantValidationError("only a field the brand defines is blanked, never a sys. field");
}

/**
 * Blank an erased field's values in this brand's field changes, one page at a time: properties
 * before and after become null, and the row gains blankedAt and blankedReason "field_erased".
 * Kind, time, actor and field id stay. Resumable: pass `last` back as startAfter while `more`.
 * Refuses a system field id. A dry run counts and writes nothing.
 */
export async function blankFieldEvents(ctx: TenantContext, fieldId: string, opts: BlankOptions): Promise<BlankResult> {
  checkUserFieldId(fieldId);
  const nowIso = nowOr(opts.nowIso);
  const limit = blankLimit(opts.limit);
  const store = regionalStoreFor(ctx, opts.db);
  const page = await pageHistory(store, ctx, "ontologyEvents", {
    where: [["fieldId", "==", fieldId]],
    fields: ["blankedAt"],
    after: opts.startAfter ?? null,
    limit,
  });
  const out: BlankResult = { scanned: page.rows.length, blanked: 0, already: 0, gone: 0, last: page.last, more: page.more };
  if (opts.dryRun) {
    for (const r of page.rows) {
      if (r.data.blankedAt == null) out.blanked += 1;
      else out.already += 1;
    }
    return out;
  }
  if (page.rows.length === 0) return out;
  const counts = await store.runTransaction(async (txn) => {
    const c = { blanked: 0, already: 0, gone: 0 };
    const refs = page.rows.map((r) => store.collection(ONTOLOGY_EVENTS).doc(r.id));
    const snaps = await Promise.all(refs.map((ref) => txn.get(ref)));
    const toBlank: DocRefLike[] = [];
    snaps.forEach((snap, i) => {
      if (!snap.exists) return void (c.gone += 1);
      const data = snap.data() ?? {};
      if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${ONTOLOGY_EVENTS}/${refs[i]!.id} belongs to another tenant`);
      if (data.blankedAt != null || data.fieldId !== fieldId) return void (c.already += 1);
      toBlank.push(refs[i]!);
    });
    for (const ref of toBlank) {
      txn.update(ref, { "properties.before": null, "properties.after": null, blankedAt: nowIso, blankedReason: "field_erased" });
      c.blanked += 1;
    }
    return c;
  });
  return { ...out, ...counts };
}

/**
 * How many of this brand's rows hold the field (total), and how many are still to blank
 * (toBlank). Equality only, so no composite index; a resumed dry run does not overstate.
 */
export async function countFieldEvents(ctx: TenantContext, fieldId: string, opts: { db?: FirestoreLike } = {}): Promise<{ total: number; toBlank: number }> {
  checkUserFieldId(fieldId);
  const repo = forTenant(ctx, opts.db);
  const [total, toBlank] = await Promise.all([
    repo.ontologyEvents.count([["fieldId", "==", fieldId]]),
    repo.ontologyEvents.count([
      ["fieldId", "==", fieldId],
      ["blankedAt", "==", null],
    ]),
  ]);
  return { total, toBlank };
}
