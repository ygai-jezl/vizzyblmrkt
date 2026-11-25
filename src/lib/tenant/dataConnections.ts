import { randomBytes } from "node:crypto";
import { TENANT_FIELD, TenantCollection } from "./repository";
import { isAlreadyExists } from "./firestore";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { regionalStoreFor } from "./ontologyEvents";
import type { FirestoreLike, TenantContext, TransactionLike } from "./types";
import {
  ACTIVITY_KINDS,
  DATA_CONNECTION_ID_RE,
  DataConnectionSchema,
  type ActivityEntry,
  type ActivityKind,
  type DataConnection,
  type DataConnectionActivity,
  type ReadActivityDetail,
} from "@/lib/types/dataConnection";

/**
 * Connected data's only writer (Connectors 1, ADR-0011). A connection's record and the activity
 * rows that record each change are written in ONE transaction in the brand's regional database,
 * so a change is never saved without its activity, nor an activity without its change.
 *
 * - Records are read and written by id, with the tenant checked on every read; activity is
 *   written and never queried by the app, so neither needs a composite index.
 * - Each activity row carries `ttlAt` as a Date, 90 days on, for the TTL policy that
 *   infra/lifecycle/setup.sh ttl turns on.
 * - The record keeps the last 20 changes, newest first, for the Connected view.
 * - id, tenantId, connectorId, method, createdAt and source never change after a connection is made.
 * - A brand's part of an organisation's connection (Connectors 3, ADR-0015) carries a `source`. Only
 *   src/lib/tenant/organisationConnections.ts makes one, through the stage variant below; its
 *   `account` changes only through that file's part change; and it never holds a secret or an
 *   address, whatever a plan returns.
 * - The stage variants (stageDataConnectionCreate, prepareDataConnectionChange) take a transaction,
 *   so a writer in src/lib/tenant can compose a connection's change with another write in the same
 *   database (a part and its settings version). They are not exported from @/lib/tenant.
 *
 * forTenant gives the records read only (find, getById, count) and the activity a count, so a
 * write that skips this file fails typecheck.
 */

export const DATA_CONNECTIONS = "data_connections";
export const DATA_CONNECTION_ACTIVITY = "data_connection_activity";
/** How many changes the record keeps for the Connected view. */
export const RECENT_LIMIT = 20;
/** How long an activity row is kept: its ttlAt is this many days after it happened. */
export const ACTIVITY_KEEP_DAYS = 90;
const DAY_MS = 86_400_000;

/** One change to record. */
export interface ActivityWrite {
  kind: ActivityKind;
  by: string;
  code?: string | null;
  /** Canonical ISO instant. */
  at: string;
  /**
   * False keeps it in the activity log only, off the record's recent list, so frequent rows (Vizzy's
   * reads) never push an admin's changes off the Connected view. Never stored.
   */
  recent?: boolean;
  /** On a live read: what was asked and the days read, kept on the activity row only. */
  read?: ReadActivityDetail;
}

/** A new connection, before the tenant is stamped. Its recent list is built from its activity. */
export type NewDataConnection = Omit<DataConnection, "tenantId" | "recent">;

/** What a change may set. The identity fields are stripped whatever a plan returns. */
export type DataConnectionPatch = Partial<Omit<DataConnection, "id" | "tenantId" | "connectorId" | "method" | "createdAt" | "recent" | "source">>;

export type ChangePlan = { patch: DataConnectionPatch; activity: ActivityWrite[] } | null;

export type ChangeResult =
  | { ok: true; connection: DataConnection }
  | { ok: false; why: "not_found" }
  | { ok: false; why: "unchanged"; connection: DataConnection };

const FIXED = ["id", TENANT_FIELD, "connectorId", "method", "createdAt", "recent", "source"] as const;

/** How a stage variant was called: by the part writer, which alone makes parts and changes their account. */
export interface PartWrite {
  part?: boolean;
}

function invalid(message: string): never {
  throw new TenantValidationError(`bad_data_connection:${message}`);
}

const SHORT = (v: unknown, max = 40) => typeof v === "string" && v.length <= max;

function checkActivity(a: ActivityWrite): void {
  if (!ACTIVITY_KINDS.includes(a.kind)) invalid("kind");
  if (!a.by || a.by.length > 200) invalid("by");
  if (Number.isNaN(Date.parse(a.at)) || new Date(a.at).toISOString() !== a.at) invalid("at");
  if (a.code != null && (typeof a.code !== "string" || a.code.length > 200)) invalid("code");
  if (a.read !== undefined) {
    const r = a.read;
    if (a.kind !== "read") invalid("read");
    const fields = Object.keys(r).sort().join(",");
    if (fields !== "by,from,limit,pageFilter,period,stream,timeZone,to") invalid("read");
    if (!SHORT(r.stream) || !SHORT(r.by) || !SHORT(r.from, 10) || !SHORT(r.to, 10) || !(r.timeZone === null || SHORT(r.timeZone, 64))) invalid("read");
    if (!Number.isInteger(r.limit) || r.limit < 1 || r.limit > 1000 || !(r.period === null || SHORT(r.period)) || typeof r.pageFilter !== "boolean") invalid("read");
  }
}

function entryOf(a: ActivityWrite): ActivityEntry {
  return { at: a.at, kind: a.kind, by: a.by, code: a.code ?? null };
}

/** The recent list with these changes added, newest first, capped. Rows marked recent: false stay off it. */
export function withRecent(current: readonly ActivityEntry[], added: readonly ActivityWrite[]): ActivityEntry[] {
  return [
    ...added
      .filter((a) => a.recent !== false)
      .map(entryOf)
      .reverse(),
    ...current,
  ].slice(0, RECENT_LIMIT);
}

function activityRow(tenantId: string, conn: Pick<DataConnection, "id" | "connectorId">, a: ActivityWrite): Omit<DataConnectionActivity, "id"> {
  return {
    [TENANT_FIELD]: tenantId,
    connectionId: conn.id,
    connectorId: conn.connectorId,
    ...entryOf(a),
    ...(a.read ? { read: { ...a.read } } : {}),
    ttlAt: new Date(Date.parse(a.at) + ACTIVITY_KEEP_DAYS * DAY_MS),
  } as Omit<DataConnectionActivity, "id">;
}

function newActivityId(): string {
  return `dca_${randomBytes(12).toString("hex")}`;
}

function stageActivity(txn: TransactionLike, store: FirestoreLike, tenantId: string, conn: Pick<DataConnection, "id" | "connectorId">, list: readonly ActivityWrite[]): void {
  for (const a of list) {
    txn.create(store.collection(DATA_CONNECTION_ACTIVITY).doc(newActivityId()), activityRow(tenantId, conn, a) as unknown as Record<string, unknown>);
  }
}

/** The stored record, parsed; null when missing or another brand's. */
function parseStored(tenantId: string, id: string, data: Record<string, unknown> | undefined): DataConnection | null {
  if (!data || data[TENANT_FIELD] !== tenantId) return null;
  const parsed = DataConnectionSchema.safeParse({ ...data, id });
  if (!parsed.success) throw new TenantValidationError(`bad_data_connection:stored:${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
  return parsed.data;
}

/** The record to create, checked, with the tenant stamped and its recent list built. */
function checkedNew(ctx: TenantContext, input: NewDataConnection, activity: ActivityWrite[], opts: PartWrite): DataConnection {
  if (!DATA_CONNECTION_ID_RE.test(input.id)) invalid("id");
  for (const a of activity) checkActivity(a);
  const { tenantId: _t, recent: _r, ...rest } = input as NewDataConnection & { tenantId?: unknown; recent?: unknown };
  if (rest.source !== undefined) {
    // Only the part writer makes a part, and a part keeps no secret and no address.
    if (!opts.part) invalid("source");
    if (Object.keys(rest.secrets).length || rest.serviceAccount) invalid("source_secrets");
  }
  const record: DataConnection = { ...rest, tenantId: ctx.tenantId, recent: withRecent([], activity) };
  const parsed = DataConnectionSchema.safeParse(record);
  if (!parsed.success) invalid(parsed.error.issues[0]?.path.join(".") ?? "record");
  return parsed.data;
}

/**
 * Stage a new connection and its first activity in a transaction the caller runs, after all its
 * reads. The atomic create refuses an id that exists, in any brand, when the transaction commits.
 * For writers in src/lib/tenant only.
 */
export function stageDataConnectionCreate(
  ctx: TenantContext,
  input: NewDataConnection,
  activity: ActivityWrite[],
  txn: TransactionLike,
  store: FirestoreLike,
  opts: PartWrite = {},
): DataConnection {
  const record = checkedNew(ctx, input, activity, opts);
  const { id, ...doc } = record;
  txn.create(store.collection(DATA_CONNECTIONS).doc(id), doc);
  stageActivity(txn, store, ctx.tenantId, record, activity);
  return record;
}

/**
 * Create a connection with its first activity (connected, verified...) in one transaction.
 * An id that already exists, in any brand, is refused (TenantIsolationError), never overwritten.
 * A part of an organisation's connection is made only by src/lib/tenant/organisationConnections.ts.
 */
export async function createDataConnection(ctx: TenantContext, input: NewDataConnection, activity: ActivityWrite[], db?: FirestoreLike): Promise<DataConnection> {
  const checked = checkedNew(ctx, input, activity, {});
  const store = regionalStoreFor(ctx, db);
  try {
    await store.runTransaction(async (txn) => {
      stageDataConnectionCreate(ctx, checked, activity, txn, store);
    });
  } catch (err) {
    if (isAlreadyExists(err)) throw new TenantIsolationError(`${DATA_CONNECTIONS}/${checked.id} already exists; refusing to overwrite`);
    throw err;
  }
  return checked;
}

/** A change read and planned in the caller's transaction: what it comes to, and the writes to stage. */
export interface PreparedChange {
  result: ChangeResult;
  /** Stage the writes; call it after every read of the transaction. Does nothing when nothing changes. */
  stage: () => void;
}

/**
 * Read a connection in the caller's transaction and plan its change, staging nothing yet. `plan`
 * sees the freshest record. A part's account changes only for the part writer (`part`), and a part
 * never takes a secret or an address. For writers in src/lib/tenant only; changeDataConnection is
 * this in a transaction of its own.
 */
export async function prepareDataConnectionChange(
  ctx: TenantContext,
  id: string,
  plan: (current: DataConnection) => ChangePlan,
  txn: TransactionLike,
  store: FirestoreLike,
  opts: PartWrite = {},
): Promise<PreparedChange> {
  const nothing = () => undefined;
  if (!DATA_CONNECTION_ID_RE.test(id)) return { result: { ok: false, why: "not_found" }, stage: nothing };
  const ref = store.collection(DATA_CONNECTIONS).doc(id);
  const snap = await txn.get(ref);
  const current = snap.exists ? parseStored(ctx.tenantId, id, snap.data()) : null;
  if (!current) return { result: { ok: false, why: "not_found" }, stage: nothing };
  const planned = plan(current);
  if (!planned) return { result: { ok: false, why: "unchanged", connection: current }, stage: nothing };
  for (const a of planned.activity) checkActivity(a);
  const patch: Record<string, unknown> = { ...planned.patch };
  for (const k of FIXED) delete patch[k];
  if (current.source) {
    if (!opts.part && patch.account !== undefined && patch.account !== current.account) delete patch.account;
    if (patch.secrets !== undefined) patch.secrets = {};
    if (patch.serviceAccount !== undefined) patch.serviceAccount = null;
  }
  const last = planned.activity.at(-1);
  if (patch.updatedAt === undefined && last) patch.updatedAt = last.at;
  if (planned.activity.some((a) => a.recent !== false)) patch.recent = withRecent(current.recent, planned.activity);
  const next = DataConnectionSchema.safeParse({ ...current, ...patch });
  if (!next.success) invalid(next.error.issues[0]?.path.join(".") ?? "patch");
  return {
    result: { ok: true, connection: next.data },
    stage: () => {
      txn.update(ref, patch);
      stageActivity(txn, store, ctx.tenantId, current, planned.activity);
    },
  };
}

/**
 * Change a connection with the activity that records it, in one transaction. `plan` sees the
 * freshest record and returns the patch and its activity, or null to leave it alone. Another
 * brand's id reads as not found. `updatedAt` is set from the last activity's time when the plan
 * doesn't set it.
 */
export async function changeDataConnection(
  ctx: TenantContext,
  id: string,
  plan: (current: DataConnection) => ChangePlan,
  db?: FirestoreLike,
): Promise<ChangeResult> {
  if (!DATA_CONNECTION_ID_RE.test(id)) return { ok: false, why: "not_found" };
  const store = regionalStoreFor(ctx, db);
  return store.runTransaction(async (txn): Promise<ChangeResult> => {
    const prepared = await prepareDataConnectionChange(ctx, id, plan, txn, store);
    prepared.stage();
    return prepared.result;
  });
}

export interface PurgeCounts {
  found: boolean;
  activityDeleted: number;
  secretsDeleted: number;
  recentDeleted: number;
}

/**
 * The operator purge (src/lib/connectors/purge.ts): delete a connection's activity rows, then, in
 * one transaction, empty its secrets and recent list, mark it disconnected and leave a single
 * "purged" row as the trace. Only this brand's rows for this connection are touched.
 */
export async function purgeDataConnection(ctx: TenantContext, id: string, by: string, at: string, db?: FirestoreLike): Promise<PurgeCounts> {
  checkActivity({ kind: "purged", by, at });
  const store = regionalStoreFor(ctx, db);
  const first = await store.collection(DATA_CONNECTIONS).doc(id).get();
  if (!first.exists || parseStored(ctx.tenantId, id, first.data()) === null) {
    return { found: false, activityDeleted: 0, secretsDeleted: 0, recentDeleted: 0 };
  }
  const activityDeleted = await new TenantCollection<DataConnectionActivity>(store, DATA_CONNECTION_ACTIVITY, ctx.tenantId).deleteWhere([["connectionId", "==", id]]);
  const ref = store.collection(DATA_CONNECTIONS).doc(id);
  return store.runTransaction(async (txn): Promise<PurgeCounts> => {
    const snap = await txn.get(ref);
    const current = snap.exists ? parseStored(ctx.tenantId, id, snap.data()) : null;
    if (!current) return { found: false, activityDeleted, secretsDeleted: 0, recentDeleted: 0 };
    const purged: ActivityWrite = { kind: "purged", by, at };
    txn.update(ref, {
      secrets: {},
      recent: withRecent([], [purged]),
      status: "disconnected",
      disconnectedAt: current.disconnectedAt ?? at,
      updatedAt: at,
    });
    stageActivity(txn, store, ctx.tenantId, current, [purged]);
    return { found: true, activityDeleted, secretsDeleted: Object.keys(current.secrets).length, recentDeleted: current.recent.length };
  });
}

/** How many activity rows a connection has (the purge's dry run). */
export async function countDataConnectionActivity(ctx: TenantContext, id: string, db?: FirestoreLike): Promise<number> {
  return new TenantCollection<DataConnectionActivity>(regionalStoreFor(ctx, db), DATA_CONNECTION_ACTIVITY, ctx.tenantId).count([["connectionId", "==", id]]);
}
