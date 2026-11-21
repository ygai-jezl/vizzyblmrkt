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
 * - id, tenantId, connectorId, method and createdAt never change after a connection is made.
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
}

/** A new connection, before the tenant is stamped. Its recent list is built from its activity. */
export type NewDataConnection = Omit<DataConnection, "tenantId" | "recent">;

/** What a change may set. The identity fields are stripped whatever a plan returns. */
export type DataConnectionPatch = Partial<Omit<DataConnection, "id" | "tenantId" | "connectorId" | "method" | "createdAt" | "recent">>;

export type ChangePlan = { patch: DataConnectionPatch; activity: ActivityWrite[] } | null;

export type ChangeResult =
  | { ok: true; connection: DataConnection }
  | { ok: false; why: "not_found" }
  | { ok: false; why: "unchanged"; connection: DataConnection };

const FIXED = ["id", TENANT_FIELD, "connectorId", "method", "createdAt", "recent"] as const;

function invalid(message: string): never {
  throw new TenantValidationError(`bad_data_connection:${message}`);
}

function checkActivity(a: ActivityWrite): void {
  if (!ACTIVITY_KINDS.includes(a.kind)) invalid("kind");
  if (!a.by || a.by.length > 200) invalid("by");
  if (Number.isNaN(Date.parse(a.at)) || new Date(a.at).toISOString() !== a.at) invalid("at");
  if (a.code != null && (typeof a.code !== "string" || a.code.length > 200)) invalid("code");
}

function entryOf(a: ActivityWrite): ActivityEntry {
  return { at: a.at, kind: a.kind, by: a.by, code: a.code ?? null };
}

/** The recent list with these changes added, newest first, capped. */
export function withRecent(current: readonly ActivityEntry[], added: readonly ActivityWrite[]): ActivityEntry[] {
  return [...added.map(entryOf).reverse(), ...current].slice(0, RECENT_LIMIT);
}

function activityRow(tenantId: string, conn: Pick<DataConnection, "id" | "connectorId">, a: ActivityWrite): Omit<DataConnectionActivity, "id"> {
  return {
    [TENANT_FIELD]: tenantId,
    connectionId: conn.id,
    connectorId: conn.connectorId,
    ...entryOf(a),
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

/**
 * Create a connection with its first activity (connected, verified...) in one transaction.
 * An id that already exists, in any brand, is refused (TenantIsolationError), never overwritten.
 */
export async function createDataConnection(ctx: TenantContext, input: NewDataConnection, activity: ActivityWrite[], db?: FirestoreLike): Promise<DataConnection> {
  if (!DATA_CONNECTION_ID_RE.test(input.id)) invalid("id");
  for (const a of activity) checkActivity(a);
  const { tenantId: _t, recent: _r, ...rest } = input as NewDataConnection & { tenantId?: unknown; recent?: unknown };
  const record: DataConnection = { ...rest, tenantId: ctx.tenantId, recent: withRecent([], activity) };
  const parsed = DataConnectionSchema.safeParse(record);
  if (!parsed.success) invalid(parsed.error.issues[0]?.path.join(".") ?? "record");
  const store = regionalStoreFor(ctx, db);
  const { id, ...doc } = parsed.data;
  try {
    await store.runTransaction(async (txn) => {
      txn.create(store.collection(DATA_CONNECTIONS).doc(id), doc);
      stageActivity(txn, store, ctx.tenantId, parsed.data, activity);
    });
  } catch (err) {
    if (isAlreadyExists(err)) throw new TenantIsolationError(`${DATA_CONNECTIONS}/${id} already exists; refusing to overwrite`);
    throw err;
  }
  return parsed.data;
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
  const ref = store.collection(DATA_CONNECTIONS).doc(id);
  return store.runTransaction(async (txn): Promise<ChangeResult> => {
    const snap = await txn.get(ref);
    const current = snap.exists ? parseStored(ctx.tenantId, id, snap.data()) : null;
    if (!current) return { ok: false, why: "not_found" };
    const planned = plan(current);
    if (!planned) return { ok: false, why: "unchanged", connection: current };
    for (const a of planned.activity) checkActivity(a);
    const patch: Record<string, unknown> = { ...planned.patch };
    for (const k of FIXED) delete patch[k];
    const last = planned.activity.at(-1);
    if (patch.updatedAt === undefined && last) patch.updatedAt = last.at;
    if (planned.activity.length) patch.recent = withRecent(current.recent, planned.activity);
    const next = DataConnectionSchema.safeParse({ ...current, ...patch });
    if (!next.success) invalid(next.error.issues[0]?.path.join(".") ?? "patch");
    txn.update(ref, patch);
    stageActivity(txn, store, ctx.tenantId, current, planned.activity);
    return { ok: true, connection: next.data };
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
