import { createHash, randomBytes } from "node:crypto";
import { getDb, isAlreadyExists } from "./firestore";
import { databaseIdForRegion, REGION_CONFIGS } from "./region";
import { forTenant } from "./repository";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { prepareDataConnectionChange, stageDataConnectionCreate, type ActivityWrite, type ChangePlan, type NewDataConnection } from "./dataConnections";
import { TENANT_FIELD } from "./repository";
import { CONNECTION_PARTS, prepareSettingsChange, settingsDocId } from "./settingsLog";
import type { EventActor } from "@/lib/ontology/events";
import type { SettingsItem } from "@/lib/types/settingsVersion";
import type { FirestoreLike, QueryLike, TenantContext, TransactionLike } from "./types";
import type { Region } from "@/lib/types/tenant";
import { CollectStateSchema, DataConnectionSchema, type DataConnection } from "@/lib/types/dataConnection";
import {
  MAX_PARTS,
  ORGANISATION_ACTIVITY_KINDS,
  ORGANISATION_CONNECTION_ID_RE,
  OrganisationConnectionSchema,
  type ConnectionPart,
  type OrganisationActivityEntry,
  type OrganisationActivityKind,
  type OrganisationConnection,
  type OrganisationConnectionActivity,
} from "@/lib/types/organisationConnection";

/**
 * Organisation connections' only writer (Connectors 3, ADR-0015): `organisation_connections` and
 * `organisation_connection_activity`, and the writer for giving, changing and taking back a brand's
 * part, with the repairs housekeeping runs.
 *
 * Where things are kept:
 * - An organisation's connection lives in the regional database of the brand it was connected from,
 *   and never moves. Organisations have no region, so every lookup by organisation reads every
 *   provisioned region (REGION_CONFIGS), and a lookup by id knows the region from the brand record's
 *   `source.region` or reads them all. A request never names a region.
 * - A brand's part is an ordinary brand record (`data_connections`) in the brand's own region, made
 *   and changed here through the stage variants of src/lib/tenant/dataConnections.ts.
 *
 * Three steps over two databases, because Firestore runs no transaction across databases (ADR-0002):
 * 1. the part's state on the organisation's record (`pending` or `ending`), in its own database;
 * 2. the brand record (and any extra write the caller stages, such as the brand's settings version),
 *    in one transaction in the brand's database, every read first;
 * 3. the part's state again (`active`, or the entry removed).
 * A brand in the sign in's own region takes the same three steps, so there is one path. Only an
 * `active` part matching the brand record reads (src/lib/connectors/sources.ts partLive), so a step
 * left half done reads nothing. Housekeeping repairs one only when the other record is readable and
 * disagrees: never on a read error, never on a switch.
 *
 * Every change to a record writes its activity rows in the same transaction; rows carry `ttlAt` 90
 * days on and are never queried. Step two also saves the brand's `connections:shared` setting
 * (`connection_parts`, one document per brand) and its version in the brand's `settings_versions`,
 * in the same transaction as the brand record: a part given is an item, a part changed archives the
 * old item with `replacedBy`, a part ended archives it (decision 30: history stays with the brand). Records are read by id and by equality on `organisationId` (with
 * `connectorId`) or `status`, so no composite index is needed. The organisation's own change log
 * (`organisation_changes`, in (default)) can't join these transactions; its writers add rows after.
 */

export const ORGANISATION_CONNECTIONS = "organisation_connections";
export const ORGANISATION_CONNECTION_ACTIVITY = "organisation_connection_activity";
const ORG_FIELD = "organisationId";
const RECENT_LIMIT = 20;
const ACTIVITY_KEEP_DAYS = 90;
const DAY_MS = 86_400_000;
/** A half done give or change is repaired only once it is this old, so a give still running is never undone. */
export const REPAIR_AFTER_MS = 10 * 60_000;
/** The organisation connections one page of a listing reads in one region; listings read every page. */
const LIST_PAGE = 200;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Where each region's database comes from: the region's own, or (tests) a fake per region. */
export interface OrganisationStores {
  regionDb?: (region: Region) => FirestoreLike;
}

/** A region's database. */
export function regionStore(region: Region, stores: OrganisationStores = {}): FirestoreLike {
  return stores.regionDb?.(region) ?? (getDb(databaseIdForRegion(region)) as unknown as FirestoreLike);
}

/** The regions with a database: an organisation's connections may be in any of them. */
export function provisionedRegions(): Region[] {
  return Object.values(REGION_CONFIGS)
    .filter((c) => c.provisioned)
    .map((c) => c.code);
}

/** `ocn_` and 20 random base32 characters. */
export function newOrganisationConnectionId(): string {
  const bytes = randomBytes(20);
  let out = "ocn_";
  for (let i = 0; i < 20; i++) out += BASE32[bytes[i]! & 31];
  return out;
}

function invalid(message: string): never {
  throw new TenantValidationError(`bad_organisation_connection:${message}`);
}

// --- Records and activity --------------------------------------------------------------------

/** One change to record on an organisation's connection. */
export interface OrgActivityWrite {
  kind: OrganisationActivityKind;
  by: string;
  code?: string | null;
  /** The brand a part change is about. */
  tenantId?: string | null;
  at: string;
}

/** A new organisation connection, before its recent list is built. */
export type NewOrganisationConnection = Omit<OrganisationConnection, "recent">;

/** What a change may set: never the identity fields, which are stripped whatever a plan returns. */
export type OrganisationConnectionPatch = Partial<
  Omit<OrganisationConnection, "id" | "organisationId" | "region" | "connectorId" | "method" | "createdAt" | "createdBy" | "connectedFromTenantId" | "recent">
>;

export type OrgChangePlan = { patch: OrganisationConnectionPatch; activity: OrgActivityWrite[] } | null;

export type OrgChangeResult =
  | { ok: true; connection: OrganisationConnection }
  | { ok: false; why: "not_found" }
  | { ok: false; why: "unchanged"; connection: OrganisationConnection };

const FIXED = ["id", ORG_FIELD, "region", "connectorId", "method", "createdAt", "createdBy", "connectedFromTenantId", "recent"] as const;

function checkActivity(a: OrgActivityWrite): void {
  if (!ORGANISATION_ACTIVITY_KINDS.includes(a.kind)) invalid("kind");
  if (!a.by || a.by.length > 200) invalid("by");
  if (Number.isNaN(Date.parse(a.at)) || new Date(a.at).toISOString() !== a.at) invalid("at");
  if (a.code != null && (typeof a.code !== "string" || a.code.length > 200)) invalid("code");
  if (a.tenantId != null && (typeof a.tenantId !== "string" || a.tenantId.length > 128)) invalid("tenantId");
}

function entryOf(a: OrgActivityWrite): OrganisationActivityEntry {
  return { at: a.at, kind: a.kind, by: a.by, code: a.code ?? null, ...(a.tenantId ? { tenantId: a.tenantId } : {}) };
}

function withRecent(current: readonly OrganisationActivityEntry[], added: readonly OrgActivityWrite[]): OrganisationActivityEntry[] {
  return [...added.map(entryOf).reverse(), ...current].slice(0, RECENT_LIMIT);
}

function stageActivity(txn: TransactionLike, store: FirestoreLike, conn: Pick<OrganisationConnection, "id" | "organisationId" | "connectorId">, list: readonly OrgActivityWrite[]): void {
  for (const a of list) {
    const row: Omit<OrganisationConnectionActivity, "id"> = {
      organisationId: conn.organisationId,
      connectionId: conn.id,
      connectorId: conn.connectorId,
      ...entryOf(a),
      ttlAt: new Date(Date.parse(a.at) + ACTIVITY_KEEP_DAYS * DAY_MS),
    };
    txn.create(store.collection(ORGANISATION_CONNECTION_ACTIVITY).doc(`oca_${randomBytes(12).toString("hex")}`), row as unknown as Record<string, unknown>);
  }
}

/** The stored record, parsed; null when missing or another organisation's. Throws on one that doesn't parse. */
function parseStored(organisationId: string | null, id: string, data: Record<string, unknown> | undefined): OrganisationConnection | null {
  if (!data) return null;
  if (organisationId !== null && data[ORG_FIELD] !== organisationId) return null;
  const parsed = OrganisationConnectionSchema.safeParse({ ...data, id });
  if (!parsed.success) throw new TenantValidationError(`bad_organisation_connection:stored:${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
  return parsed.data;
}

/**
 * Create an organisation's connection with its first activity, in the region it is kept in. An id
 * that already exists is refused (TenantIsolationError), never overwritten.
 */
export async function createOrganisationConnection(input: NewOrganisationConnection, activity: OrgActivityWrite[], stores: OrganisationStores = {}): Promise<OrganisationConnection> {
  if (!ORGANISATION_CONNECTION_ID_RE.test(input.id)) invalid("id");
  if (!input.organisationId || !input.organisationId.startsWith("org_")) invalid("organisationId");
  for (const a of activity) checkActivity(a);
  const parsed = OrganisationConnectionSchema.safeParse({ ...input, recent: withRecent([], activity) });
  if (!parsed.success) invalid(parsed.error.issues[0]?.path.join(".") ?? "record");
  const store = regionStore(parsed.data.region, stores);
  const { id, ...doc } = parsed.data;
  try {
    await store.runTransaction(async (txn) => {
      txn.create(store.collection(ORGANISATION_CONNECTIONS).doc(id), doc as unknown as Record<string, unknown>);
      stageActivity(txn, store, parsed.data, activity);
    });
  } catch (err) {
    if (isAlreadyExists(err)) throw new TenantIsolationError(`${ORGANISATION_CONNECTIONS}/${id} already exists; refusing to overwrite`);
    throw err;
  }
  return parsed.data;
}

/** An organisation's connection by id in one region, or null when it is missing or another organisation's. */
export async function getOrganisationConnection(organisationId: string, id: string, region: Region, stores: OrganisationStores = {}): Promise<OrganisationConnection | null> {
  if (!ORGANISATION_CONNECTION_ID_RE.test(id) || !organisationId) return null;
  const snap = await regionStore(region, stores).collection(ORGANISATION_CONNECTIONS).doc(id).get();
  return snap.exists ? parseStored(organisationId, id, snap.data()) : null;
}

/**
 * An organisation's connection by id, wherever it is kept: every provisioned region is read, and
 * the one found must be this organisation's. Null when none is. A region that can't be read throws,
 * so a route answers that it couldn't look rather than "not found".
 */
export async function findOrganisationConnection(organisationId: string, id: string, stores: OrganisationStores = {}): Promise<OrganisationConnection | null> {
  if (!ORGANISATION_CONNECTION_ID_RE.test(id) || !organisationId) return null;
  for (const region of provisionedRegions()) {
    const found = await getOrganisationConnection(organisationId, id, region, stores);
    if (found) return found;
  }
  return null;
}

/**
 * An organisation's connections in every provisioned region (equality on `organisationId`, and on
 * `connectorId` when given), newest first. Every page is read (ordered by document id), so a
 * caller that clears an id for reuse, a purge or a cap never takes a full page for the whole list.
 * A region that can't be read throws: a purge or a sweep must never take one region's silence for
 * "none".
 */
export async function listOrganisationConnections(
  organisationId: string,
  opts: { connectorId?: string } = {},
  stores: OrganisationStores = {},
): Promise<OrganisationConnection[]> {
  if (!organisationId) return [];
  const out: OrganisationConnection[] = [];
  for (const region of provisionedRegions()) {
    let after: string | null = null;
    for (;;) {
      let q: QueryLike = regionStore(region, stores).collection(ORGANISATION_CONNECTIONS).where(ORG_FIELD, "==", organisationId);
      if (opts.connectorId) q = q.where("connectorId", "==", opts.connectorId);
      q = q.orderBy("__name__", "asc");
      if (after) q = q.startAfter(after);
      const snap = await q.limit(LIST_PAGE).get();
      for (const d of snap.docs) {
        const c = parseStored(organisationId, d.id, d.data());
        if (c) out.push(c);
      }
      if (snap.docs.length < LIST_PAGE) break;
      after = snap.docs[snap.docs.length - 1]!.id;
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One page of every organisation's connections in one region, by document id, for system jobs. */
export interface OrganisationConnectionPage {
  records: OrganisationConnection[];
  /** Ids of stored records that don't parse: never treated as gone, so nothing is decided on them. */
  unreadable: string[];
  /** The page's last document id, the next page's `after`; null for an empty page. */
  last: string | null;
  /** The page came back full, so another may follow. */
  full: boolean;
}

/**
 * One page of every organisation's connections in one region (with `connected`, equality on
 * status), ordered by document id and starting after `after`. For system jobs only: the lane's
 * sweep, the organisation purge and the reseal.
 */
export async function pageRegionOrganisationConnections(
  region: Region,
  opts: { connected?: boolean; after?: string | null; limit?: number } = {},
  stores: OrganisationStores = {},
): Promise<OrganisationConnectionPage> {
  const limit = opts.limit ?? LIST_PAGE;
  let q: QueryLike = regionStore(region, stores).collection(ORGANISATION_CONNECTIONS);
  if (opts.connected) q = q.where("status", "==", "connected");
  q = q.orderBy("__name__", "asc");
  if (opts.after) q = q.startAfter(opts.after);
  const snap = await q.limit(limit).get();
  const records: OrganisationConnection[] = [];
  const unreadable: string[] = [];
  for (const d of snap.docs) {
    try {
      const c = parseStored(null, d.id, d.data());
      if (c) records.push(c);
    } catch {
      console.warn(`[organisation-connections] ${d.id} does not parse; counted as unreadable`);
      unreadable.push(d.id);
    }
  }
  return { records, unreadable, last: snap.docs.length ? snap.docs[snap.docs.length - 1]!.id : null, full: snap.docs.length >= limit };
}

/**
 * Every organisation's connections in one region, every page, with the ids of stored records that
 * don't parse, so the organisation purge and the reseal count them as left rather than skip them.
 */
export async function scanRegionOrganisationConnections(
  region: Region,
  opts: { connected?: boolean } = {},
  stores: OrganisationStores = {},
): Promise<{ records: OrganisationConnection[]; unreadable: string[] }> {
  const records: OrganisationConnection[] = [];
  const unreadable: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await pageRegionOrganisationConnections(region, { connected: opts.connected, after }, stores);
    records.push(...page.records);
    unreadable.push(...page.unreadable);
    if (!page.full || !page.last) break;
    after = page.last;
  }
  return { records, unreadable };
}

/** Every organisation's connections in one region, every page; records that don't parse are left out (see scanRegionOrganisationConnections). */
export async function listRegionOrganisationConnections(region: Region, opts: { connected?: boolean } = {}, stores: OrganisationStores = {}): Promise<OrganisationConnection[]> {
  return (await scanRegionOrganisationConnections(region, opts, stores)).records;
}

/** A change read and planned in a transaction, its writes still to stage. */
async function prepareOrgChange(
  store: FirestoreLike,
  organisationId: string,
  id: string,
  plan: (current: OrganisationConnection) => OrgChangePlan,
  txn: TransactionLike,
): Promise<{ result: OrgChangeResult; stage: () => void }> {
  const nothing = () => undefined;
  const ref = store.collection(ORGANISATION_CONNECTIONS).doc(id);
  const snap = await txn.get(ref);
  const current = snap.exists ? parseStored(organisationId, id, snap.data()) : null;
  if (!current) return { result: { ok: false, why: "not_found" }, stage: nothing };
  const planned = plan(current);
  if (!planned) return { result: { ok: false, why: "unchanged", connection: current }, stage: nothing };
  for (const a of planned.activity) checkActivity(a);
  const patch: Record<string, unknown> = { ...planned.patch };
  for (const k of FIXED) delete patch[k];
  const last = planned.activity.at(-1);
  if (patch.updatedAt === undefined) patch.updatedAt = last?.at ?? new Date().toISOString();
  if (planned.activity.length) patch.recent = withRecent(current.recent, planned.activity);
  const next = OrganisationConnectionSchema.safeParse({ ...current, ...patch });
  if (!next.success) invalid(next.error.issues[0]?.path.join(".") ?? "patch");
  return {
    result: { ok: true, connection: next.data },
    stage: () => {
      txn.update(ref, patch);
      stageActivity(txn, store, current, planned.activity);
    },
  };
}

/**
 * Change an organisation's connection with the activity that records it, in one transaction in the
 * region it is kept in. `plan` sees the freshest record; another organisation's id reads as not found.
 */
export async function changeOrganisationConnection(
  organisationId: string,
  id: string,
  region: Region,
  plan: (current: OrganisationConnection) => OrgChangePlan,
  stores: OrganisationStores = {},
): Promise<OrgChangeResult> {
  if (!ORGANISATION_CONNECTION_ID_RE.test(id) || !organisationId) return { ok: false, why: "not_found" };
  const store = regionStore(region, stores);
  return store.runTransaction(async (txn) => {
    const prepared = await prepareOrgChange(store, organisationId, id, plan, txn);
    prepared.stage();
    return prepared.result;
  });
}

export interface OrganisationPurgeCounts {
  found: boolean;
  activityDeleted: number;
  secretsDeleted: number;
  recentDeleted: number;
  /** Parts still listed, whose brand record wasn't ended: kept as `ending`, so the dry run still counts them. */
  partsLeft: number;
}

/** How many activity rows an organisation's connection has (the purge's dry run). */
export async function countOrganisationConnectionActivity(organisationId: string, id: string, region: Region, stores: OrganisationStores = {}): Promise<number> {
  const snap = await regionStore(region, stores)
    .collection(ORGANISATION_CONNECTION_ACTIVITY)
    .where(ORG_FIELD, "==", organisationId)
    .where("connectionId", "==", id)
    .count()
    .get();
  return snap.data().count;
}

/**
 * The organisation purge's last step: delete a connection's activity rows, then, in one
 * transaction, empty its secrets and recent list, mark it disconnected and leave one "purged" row as
 * the trace. Its brands' parts are ended first (src/lib/connectors/purge.ts), and each one ended
 * leaves `parts`; an entry still listed is one whose brand record couldn't be ended, so it is kept,
 * as `ending`, for the next run and the dry run's count (and the brand's own housekeeping ends it,
 * since its source reads disconnected).
 */
export async function purgeOrganisationConnection(organisationId: string, id: string, region: Region, by: string, at: string, stores: OrganisationStores = {}): Promise<OrganisationPurgeCounts> {
  checkActivity({ kind: "purged", by, at });
  const store = regionStore(region, stores);
  const first = await getOrganisationConnection(organisationId, id, region, stores);
  if (!first) return { found: false, activityDeleted: 0, secretsDeleted: 0, recentDeleted: 0, partsLeft: 0 };
  let activityDeleted = 0;
  for (;;) {
    const page = await store.collection(ORGANISATION_CONNECTION_ACTIVITY).where(ORG_FIELD, "==", organisationId).where("connectionId", "==", id).limit(300).get();
    if (page.empty) break;
    for (const d of page.docs) await store.collection(ORGANISATION_CONNECTION_ACTIVITY).doc(d.id).delete();
    activityDeleted += page.docs.length;
  }
  const ref = store.collection(ORGANISATION_CONNECTIONS).doc(id);
  return store.runTransaction(async (txn): Promise<OrganisationPurgeCounts> => {
    const snap = await txn.get(ref);
    const current = snap.exists ? parseStored(organisationId, id, snap.data()) : null;
    if (!current) return { found: false, activityDeleted, secretsDeleted: 0, recentDeleted: 0, partsLeft: 0 };
    const purged: OrgActivityWrite = { kind: "purged", by, at };
    txn.update(ref, {
      secrets: {},
      recent: withRecent([], [purged]),
      parts: current.parts.map((p) => (p.state === "ending" ? p : { ...p, state: "ending" as const, stateSince: at, endedBy: p.endedBy ?? by })),
      collectHold: null,
      status: "disconnected",
      disconnectedAt: current.disconnectedAt ?? at,
      updatedAt: at,
    });
    stageActivity(txn, store, current, [purged]);
    return { found: true, activityDeleted, secretsDeleted: Object.keys(current.secrets).length, recentDeleted: current.recent.length, partsLeft: current.parts.length };
  });
}

// --- Parts: give, change and take back, three steps over two databases -----------------------

/** The organisation's connection a part comes from. */
export interface SourceRef {
  organisationId: string;
  connectionId: string;
  /** The region it is kept in (the brand record's `source.region`). */
  region: Region;
}

/** The brand a part is given to: its id and its region, from its registry record, never a request. */
export interface BrandRef {
  tenantId: string;
  region: Region;
}

/**
 * More writes in step two's transaction, in the brand's database (the brand's settings version):
 * its reads run first, then `stage` after the brand record's. Refusing undoes step one.
 */
export type StepTwoStage = (txn: TransactionLike, store: FirestoreLike) => Promise<{ ok: true; stage: () => void } | { ok: false; why: string }>;

const brandCtxOf = (brand: BrandRef): TenantContext => ({ tenantId: brand.tenantId, region: brand.region, source: "system" });

// --- The brand's settings history of its parts (connections:shared) ---------------------------

const PARTS_SUBJECT = "connections:shared" as const;

/** One part as the brand's `connections:shared` setting keeps it: ids, the part and who gave it, never a secret. */
export interface PartSettingItem extends SettingsItem {
  connectorId: string;
  organisationId: string;
  /** The organisation's connection, and the region it is kept in. */
  connectionId: string;
  sourceRegion: Region;
  /** The brand record that reads it. */
  useId: string;
  account: string;
  givenBy: string;
  givenAt: string;
}

/** A part's item key: the brand record and the part, so a change makes a new item and archives the old. */
export function partItemKey(useId: string, account: string): string {
  return `p_${createHash("sha256").update(`${useId}\n${account}`).digest("hex").slice(0, 24)}`;
}

/** Who saved a version: a person by user id, or housekeeping. */
const actorOf = (by: string): EventActor => (!by || by === "system" ? { type: "system", id: "connectors" } : { type: "member", id: by.slice(0, 200) });

/** What a step does to the brand's parts setting. */
type PartSettingOp =
  | { kind: "give"; source: SourceRef; connectorId: string; useId: string; account: string }
  | { kind: "change"; source: SourceRef; connectorId: string; useId: string; from: string; to: string }
  | { kind: "end"; useId: string };

function itemOf(op: { source: SourceRef; connectorId: string; useId: string }, account: string, by: string, at: string): PartSettingItem {
  return {
    key: partItemKey(op.useId, account),
    label: account.slice(0, 200),
    archivedAt: null,
    replacedBy: null,
    connectorId: op.connectorId,
    organisationId: op.source.organisationId,
    connectionId: op.source.connectionId,
    sourceRegion: op.source.region,
    useId: op.useId,
    account,
    givenBy: by,
    givenAt: at,
  };
}

/** Add an item, or bring an archived one back as given now. */
function withItem(items: PartSettingItem[], item: PartSettingItem): PartSettingItem[] {
  return items.some((it) => it.key === item.key) ? items.map((it) => (it.key === item.key ? item : it)) : [...items, item];
}

/** The setting after the step, or null when it changes nothing (archived items are kept, never removed). */
function applyPartOp(items: PartSettingItem[], op: PartSettingOp, by: string, at: string): PartSettingItem[] | null {
  if (op.kind === "give") {
    const item = itemOf(op, op.account, by, at);
    return items.some((it) => it.key === item.key && !it.archivedAt) ? null : withItem(items, item);
  }
  if (op.kind === "change") {
    const next = itemOf(op, op.to, by, at);
    const archived = items.map((it) => (it.useId === op.useId && !it.archivedAt && it.key !== next.key ? { ...it, archivedAt: at, replacedBy: next.key } : it));
    return withItem(archived, next);
  }
  if (!items.some((it) => it.useId === op.useId && !it.archivedAt)) return null;
  return items.map((it) => (it.useId === op.useId && !it.archivedAt ? { ...it, archivedAt: at } : it));
}

/** Why a part ended, in the brand's history. */
const END_MESSAGES: Record<string, string> = {
  part_ended: "Taken back by the organisation",
  stopped_using: "Stopped using it",
  left: "Ended: the brand left the organisation",
  disconnected: "Ended: the organisation disconnected it",
  repaired: "Ended by housekeeping",
};

/**
 * Step two's write to the brand's parts setting and its version, in the brand's database, reads
 * first. Refuses (settings_changed) only when the setting moved on inside the transaction, which
 * the transaction's own retry resolves.
 */
function partSettingStage(brand: BrandRef, op: PartSettingOp, by: string, at: string, message: string): StepTwoStage {
  return async (txn, store) => {
    const ctx = brandCtxOf(brand);
    // The subject's home (SETTINGS_HOMES["connections:shared"]).
    const ref = store.collection(CONNECTION_PARTS).doc(settingsDocId(brand.tenantId, PARTS_SUBJECT));
    const snap = await txn.get(ref);
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (data && data[TENANT_FIELD] !== brand.tenantId) throw new TenantIsolationError(`${CONNECTION_PARTS}/${ref.id} belongs to another tenant`);
    const items = Array.isArray(data?.items) ? (data!.items as PartSettingItem[]) : [];
    const rev = typeof data?.rev === "number" ? data.rev : 0;
    const next = applyPartOp(items, op, by, at);
    if (!next) return { ok: true, stage: () => undefined };
    const prepared = await prepareSettingsChange(ctx, { subject: PARTS_SUBJECT, baseRev: rev, value: { items: next }, by: actorOf(by), source: "editor", message, nowIso: at }, txn, store);
    if (!prepared.ok) return { ok: false, why: "settings_changed" };
    return { ok: true, stage: prepared.stage };
  };
}

/** Several step two writes as one: each one's reads in turn, then every stage. Any refusal refuses all. */
function composeStages(...stages: Array<StepTwoStage | undefined>): StepTwoStage {
  return async (txn, store) => {
    const ready: Array<() => void> = [];
    for (const s of stages) {
      if (!s) continue;
      const r = await s(txn, store);
      if (!r.ok) return r;
      ready.push(r.stage);
    }
    return { ok: true, stage: () => ready.forEach((f) => f()) };
  };
}

const sameSource = (c: Pick<DataConnection, "source">, src: SourceRef) =>
  c.source?.organisationId === src.organisationId && c.source.connectionId === src.connectionId && c.source.region === src.region;

/** A brand record ended as a take back: disconnected, everything it collected marked for erasing, any secret emptied. */
function endedPlan(by: string, at: string, code: string): (cur: DataConnection) => ChangePlan {
  return (cur) => {
    if (cur.status !== "connected") return null;
    const collect = { ...(cur.collect ?? CollectStateSchema.parse({})), erasePending: "all" as const, nextAt: null, leaseId: null, leaseUntil: null };
    return {
      patch: { status: "disconnected", disconnectedAt: at, pausedAt: null, pausedBy: null, secrets: {}, collect },
      // "disconnected" is a kind every build knows; the code says why (part_ended, stopped_using, left).
      activity: [{ kind: "disconnected", by, at, code }],
    };
  };
}

const replacePart = (parts: readonly ConnectionPart[], useId: string, next: ConnectionPart | null): ConnectionPart[] =>
  next ? parts.map((p) => (p.useId === useId ? next : p)) : parts.filter((p) => p.useId !== useId);

export interface GivePartInput {
  source: SourceRef;
  brand: BrandRef;
  /**
   * The brand record to make, whose id is the part's `useId` (made before step one). Its connector
   * and method must be the source's; its `source` is set here, and it keeps no secret or address.
   */
  record: Omit<NewDataConnection, "source">;
  recordActivity: ActivityWrite[];
  by: string;
  at: string;
  alsoStage?: StepTwoStage;
}

export type GivePartRefusal = "not_found" | "not_connected" | "mismatch" | "has_part" | "part_given" | "too_many" | "own_connection" | "gone";

export type GivePartResult =
  | { ok: true; connection: DataConnection; active: boolean }
  | { ok: false; why: GivePartRefusal | string };

/**
 * Give a brand one part of an organisation's connection, in three steps:
 * 1. in the sign in's database: the brand holds no part of this connection and the part isn't given
 *    (a pending one counts), then the part is added as `pending` with the brand record's id;
 * 2. in the brand's database, one transaction, every read first: the brand has no connection of its
 *    own to the part (looked up just before, and again just after it commits: these transactions
 *    read documents, not queries, so an own connection picked in between ends the new part, which
 *    never read, and the give answers `own_connection`), then the brand record is made with its
 *    `source`, beside any extra write. A refusal undoes step one;
 * 3. in the sign in's database: `active`, if still `pending` with this record. If the part is gone,
 *    the brand record just made is ended and the give answers `gone`.
 * If step three can't be written the give stands, reading nothing, until housekeeping makes it
 * `active` (after REPAIR_AFTER_MS).
 */
export async function givePart(input: GivePartInput, stores: OrganisationStores = {}): Promise<GivePartResult> {
  const { source, brand, record, by, at } = input;
  const account = record.account;
  if (!account) invalid("account");
  const useId = record.id;
  const brandStore = regionStore(brand.region, stores);
  const brandCtx = brandCtxOf(brand);

  // 1. The part, pending.
  let refused: GivePartRefusal | null = null;
  const pending: ConnectionPart = { tenantId: brand.tenantId, region: brand.region, account, useId, state: "pending", stateSince: at, was: null, givenBy: by, givenAt: at, endedBy: null };
  const one = await changeOrganisationConnection(
    source.organisationId,
    source.connectionId,
    source.region,
    (cur) => {
      refused = null;
      if (cur.status !== "connected") refused = "not_connected";
      else if (cur.connectorId !== record.connectorId || cur.method !== record.method) refused = "mismatch";
      else if (cur.parts.some((p) => p.tenantId === brand.tenantId)) refused = "has_part";
      else if (cur.parts.some((p) => p.account === account || p.was === account)) refused = "part_given";
      else if (cur.parts.length >= MAX_PARTS) refused = "too_many";
      if (refused) return null;
      return { patch: { parts: [...cur.parts, pending], updatedAt: at }, activity: [] };
    },
    stores,
  );
  if (!one.ok) return { ok: false, why: one.why === "not_found" ? "not_found" : (refused ?? "not_connected") };

  const undo = () =>
    changeOrganisationConnection(
      source.organisationId,
      source.connectionId,
      source.region,
      (cur) => {
        const p = cur.parts.find((x) => x.useId === useId && x.tenantId === brand.tenantId);
        return p && p.state === "pending" ? { patch: { parts: replacePart(cur.parts, useId, null), updatedAt: at }, activity: [] } : null;
      },
      stores,
    ).catch(() => null);

  // 2. The brand record, in the brand's own database.
  const own = await forTenant(brandCtx, brandStore).dataConnections.find({
    where: [
      ["connectorId", "==", record.connectorId],
      ["account", "==", account],
      ["status", "==", "connected"],
    ],
    limit: 5,
  });
  if (own.some((c) => !c.source)) {
    await undo();
    return { ok: false, why: "own_connection" };
  }
  let made: DataConnection;
  const giveStage = composeStages(partSettingStage(brand, { kind: "give", source, connectorId: record.connectorId, useId, account }, by, at, "Given by the organisation"), input.alsoStage);
  try {
    const two = await brandStore.runTransaction(async (txn): Promise<{ ok: true; made: DataConnection } | { ok: false; why: string }> => {
      const extra = await giveStage(txn, brandStore);
      if (!extra.ok) return extra;
      const created = stageDataConnectionCreate(brandCtx, { ...record, source: { ...source } }, input.recordActivity, txn, brandStore, { part: true });
      extra.stage();
      return { ok: true, made: created };
    });
    if (!two.ok) {
      await undo();
      return two;
    }
    made = two.made;
  } catch (err) {
    await undo();
    if (isAlreadyExists(err)) throw new TenantIsolationError(`data_connections/${useId} already exists; refusing to overwrite`);
    throw err;
  }

  // The look for the brand's own connection ran before step two (a query can't join these
  // transactions), so look again now: one picked meanwhile ends the new part before it reads.
  const ownSince = await forTenant(brandCtx, brandStore)
    .dataConnections.find({
      where: [
        ["connectorId", "==", record.connectorId],
        ["account", "==", account],
        ["status", "==", "connected"],
      ],
      limit: 5,
    })
    .catch(() => [] as DataConnection[]);
  if (ownSince.some((c) => !c.source)) {
    await endPart({ source, brand, useId, by, at, code: "part_ended", evenIfSourceFails: true }, stores).catch(() => null);
    return { ok: false, why: "own_connection" };
  }

  // 3. Active, if the part is still there.
  let gone = false;
  try {
    const three = await changeOrganisationConnection(
      source.organisationId,
      source.connectionId,
      source.region,
      (cur) => {
        const p = cur.parts.find((x) => x.useId === useId && x.tenantId === brand.tenantId);
        gone = !p || p.state === "ending" || p.account !== account;
        if (!p || p.state !== "pending" || gone) return null;
        return { patch: { parts: replacePart(cur.parts, useId, { ...p, state: "active", stateSince: at }) }, activity: [{ kind: "part_given", by, at, tenantId: brand.tenantId }] };
      },
      stores,
    );
    if (!three.ok && three.why === "not_found") gone = true;
  } catch {
    // The give stands, reading nothing, until housekeeping finds the brand record and makes it active.
    return { ok: true, connection: made, active: false };
  }
  if (gone) {
    await brandStore.runTransaction(async (txn) => {
      const extra = await partSettingStage(brand, { kind: "end", useId }, by, at, END_MESSAGES.part_ended!)(txn, brandStore);
      const p = await prepareDataConnectionChange(brandCtx, useId, endedPlan(by, at, "part_ended"), txn, brandStore, { part: true });
      p.stage();
      if (extra.ok && p.result.ok) extra.stage();
    });
    return { ok: false, why: "gone" };
  }
  return { ok: true, connection: made, active: true };
}

export interface ChangePartInput {
  source: SourceRef;
  brand: BrandRef;
  /** The brand record the part is (its useId). */
  useId: string;
  /** The new part. */
  account: string;
  by: string;
  at: string;
  /**
   * The brand record's change for the new part (the connector layer's Change property: account,
   * generation and what to erase). It must set `account` to the new part.
   */
  plan: (cur: DataConnection) => ChangePlan;
  alsoStage?: StepTwoStage;
}

export type ChangePartResult = { ok: true; connection: DataConnection; was: string; active: boolean } | { ok: false; why: "not_found" | "no_part" | "busy" | "same" | "part_given" | "unchanged" | string };

/**
 * Change a brand's part, in three steps: the part goes `pending` with the new part, keeping the old
 * in `was` (the brand stops reading the old at once); the brand record changes in its own database
 * with the caller's plan; then `active`, with `was` dropped. A step two that changes nothing puts
 * the old part back.
 */
export async function changePart(input: ChangePartInput, stores: OrganisationStores = {}): Promise<ChangePartResult> {
  const { source, brand, useId, account, by, at } = input;
  if (!account) invalid("account");
  const brandStore = regionStore(brand.region, stores);
  const brandCtx = brandCtxOf(brand);

  let why: string | null = null;
  let was = "";
  let connectorId = "";
  const one = await changeOrganisationConnection(
    source.organisationId,
    source.connectionId,
    source.region,
    (cur) => {
      why = null;
      const p = cur.parts.find((x) => x.useId === useId && x.tenantId === brand.tenantId);
      if (cur.status !== "connected" || !p) why = "no_part";
      else if (p.state !== "active") why = "busy";
      else if (p.account === account) why = "same";
      else if (cur.parts.some((x) => x.useId !== useId && (x.account === account || x.was === account))) why = "part_given";
      if (why || !p) return null;
      was = p.account;
      connectorId = cur.connectorId;
      return { patch: { parts: replacePart(cur.parts, useId, { ...p, state: "pending", stateSince: at, account, was: p.account }), updatedAt: at }, activity: [] };
    },
    stores,
  );
  if (!one.ok) return { ok: false, why: one.why === "not_found" ? "not_found" : (why ?? "no_part") };

  const putBack = () =>
    changeOrganisationConnection(
      source.organisationId,
      source.connectionId,
      source.region,
      (cur) => {
        const p = cur.parts.find((x) => x.useId === useId);
        return p && p.state === "pending" && p.was ? { patch: { parts: replacePart(cur.parts, useId, { ...p, state: "active", stateSince: at, account: p.was, was: null }), updatedAt: at }, activity: [] } : null;
      },
      stores,
    ).catch(() => null);

  let changed: DataConnection;
  try {
    const two = await brandStore.runTransaction(async (txn): Promise<{ ok: true; changed: DataConnection } | { ok: false; why: string }> => {
      const changeStage = composeStages(partSettingStage(brand, { kind: "change", source, connectorId, useId, from: was, to: account }, by, at, "Changed by the organisation"), input.alsoStage);
      const extra = await changeStage(txn, brandStore);
      if (!extra.ok) return extra;
      const prepared = await prepareDataConnectionChange(
        brandCtx,
        useId,
        (cur) => {
          if (cur.status !== "connected" || !sameSource(cur, source) || cur.account !== was) return null;
          const planned = input.plan(cur);
          return planned && planned.patch.account === account ? planned : null;
        },
        txn,
        brandStore,
        { part: true },
      );
      if (!prepared.result.ok) return { ok: false, why: prepared.result.why };
      prepared.stage();
      extra.stage();
      return { ok: true, changed: prepared.result.connection };
    });
    if (!two.ok) {
      await putBack();
      return two;
    }
    changed = two.changed;
  } catch (err) {
    await putBack();
    throw err;
  }

  try {
    await changeOrganisationConnection(
      source.organisationId,
      source.connectionId,
      source.region,
      (cur) => {
        const p = cur.parts.find((x) => x.useId === useId);
        if (!p || p.state !== "pending" || p.account !== account) return null;
        return { patch: { parts: replacePart(cur.parts, useId, { ...p, state: "active", stateSince: at, was: null }) }, activity: [{ kind: "part_changed", by, at, tenantId: brand.tenantId }] };
      },
      stores,
    );
  } catch {
    return { ok: true, connection: changed, was, active: false };
  }
  return { ok: true, connection: changed, was, active: true };
}

export interface EndPartInput {
  source: SourceRef;
  brand: BrandRef;
  useId: string;
  by: string;
  at: string;
  /** Why, on the brand record's disconnected row: part_ended (taken back), stopped_using, left. */
  code: "part_ended" | "stopped_using" | "left" | "disconnected";
  alsoStage?: StepTwoStage;
  /** Stop using: end the brand record even when the sign in's database can't be written. */
  evenIfSourceFails?: boolean;
  /**
   * Housekeeping: end only if this still holds on the freshest organisation record, read inside
   * step one's transaction (the end's evidence, read again). False ends nothing; a step one that
   * can't run ends nothing either, whatever `evenIfSourceFails` says. A record that is gone is
   * evidence itself, so it ends without asking.
   */
  onlyIf?: (current: OrganisationConnection) => boolean;
}

export interface EndPartResult {
  /** The brand record went disconnected now (so what it collected is to be erased). */
  ended: boolean;
  /** The entry left the organisation's record. */
  removed: boolean;
  connection: DataConnection | null;
}

/**
 * End a brand's part (take back, Stop using, a brand leaving, Disconnect at the organisation), in
 * three steps: `ending` on the organisation's record (the brand stops reading at once); the brand
 * record disconnected with everything it collected marked for erasing and any secret emptied; then
 * the entry removed. Ending is always safe to finish: a missing organisation record or entry goes on
 * to step two, and a failed step three is finished by housekeeping. Never revokes, never deletes an
 * address. The caller erases what the brand record collected.
 */
export async function endPart(input: EndPartInput, stores: OrganisationStores = {}): Promise<EndPartResult> {
  const { source, brand, useId, by, at } = input;
  const brandStore = regionStore(brand.region, stores);
  const brandCtx = brandCtxOf(brand);

  let blocked = false;
  try {
    await changeOrganisationConnection(
      source.organisationId,
      source.connectionId,
      source.region,
      (cur) => {
        blocked = Boolean(input.onlyIf && !input.onlyIf(cur));
        if (blocked) return null;
        const p = cur.parts.find((x) => x.useId === useId && x.tenantId === brand.tenantId);
        if (!p || p.state === "ending") return null;
        return { patch: { parts: replacePart(cur.parts, useId, { ...p, state: "ending", stateSince: at, endedBy: by }), updatedAt: at }, activity: [] };
      },
      stores,
    );
  } catch (err) {
    if (input.onlyIf || !input.evenIfSourceFails) throw err;
  }
  if (blocked) return { ended: false, removed: false, connection: null };

  const endStage = composeStages(partSettingStage(brand, { kind: "end", useId }, by, at, END_MESSAGES[input.code] ?? END_MESSAGES.part_ended!), input.alsoStage);
  const two = await brandStore.runTransaction(async (txn) => {
    const extra = await endStage(txn, brandStore);
    const prepared = await prepareDataConnectionChange(brandCtx, useId, (cur) => (sameSource(cur, source) ? endedPlan(by, at, input.code)(cur) : null), txn, brandStore, { part: true });
    prepared.stage();
    if (extra.ok && prepared.result.ok) extra.stage();
    return prepared.result;
  });
  const ended = two.ok;
  const connection = two.ok ? two.connection : two.why === "unchanged" ? two.connection : null;

  let removed = false;
  try {
    removed = await removePartEntry(source, brand.tenantId, useId, { by, at, code: input.code }, stores);
  } catch {
    // Housekeeping removes it: the brand record reads disconnected.
  }
  return { ended, removed, connection };
}

/** Step three of an end alone: remove a part's entry (any state) and record who ended it. True when removed. */
export async function removePartEntry(source: SourceRef, tenantId: string, useId: string, what: { by: string; at: string; code: string }, stores: OrganisationStores = {}): Promise<boolean> {
  const r = await changeOrganisationConnection(
    source.organisationId,
    source.connectionId,
    source.region,
    (cur) => {
      const p = cur.parts.find((x) => x.useId === useId && x.tenantId === tenantId);
      if (!p) return null;
      return { patch: { parts: replacePart(cur.parts, useId, null) }, activity: [{ kind: "part_ended", by: p.endedBy ?? what.by, at: what.at, code: what.code, tenantId }] };
    },
    stores,
  );
  return r.ok;
}

/**
 * Disconnect an organisation's connection, step one: in its own database, it goes disconnected,
 * its secrets are emptied and every part goes `ending`, so every brand stops reading at once.
 * Returns the record as it was (its sealed refresh token and Google address, for revoking and
 * deleting) and as it is now; null when it was disconnected already or isn't found. The caller then
 * ends each part (endPart) and deletes the address.
 */
export async function disconnectOrganisationConnectionRecord(
  source: SourceRef,
  what: { by: string; at: string },
  stores: OrganisationStores = {},
): Promise<{ before: OrganisationConnection; after: OrganisationConnection } | null> {
  let before: OrganisationConnection | null = null;
  const r = await changeOrganisationConnection(
    source.organisationId,
    source.connectionId,
    source.region,
    (cur) => {
      before = null;
      if (cur.status !== "connected") return null;
      before = cur;
      return {
        patch: {
          status: "disconnected",
          disconnectedAt: what.at,
          secrets: {},
          pausedAt: null,
          pausedBy: null,
          collectHold: null,
          refresh: { leaseId: null, leaseUntil: null },
          parts: cur.parts.map((p) => (p.state === "ending" ? p : { ...p, state: "ending" as const, stateSince: what.at, endedBy: what.by })),
        },
        activity: [{ kind: "disconnected", by: what.by, at: what.at }],
      };
    },
    stores,
  );
  return r.ok && before ? { before, after: r.connection } : null;
}

// --- Repairs (housekeeping) ------------------------------------------------------------------

export type RepairOutcome = "activated" | "put_back" | "removed" | "finished" | "skipped";

/** A brand record read in its own region; undefined when the read failed. */
async function brandRecord(part: ConnectionPart, stores: OrganisationStores): Promise<DataConnection | null | undefined> {
  try {
    const raw = await forTenant({ tenantId: part.tenantId, region: part.region, source: "system" }, regionStore(part.region, stores)).dataConnections.getById(part.useId);
    if (!raw) return null;
    const parsed = DataConnectionSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Repair the parts a give, change or take back left half done, on positive evidence only: the
 * brand record, read in the brand's own region, and the organisation's record both readable, and
 * disagreeing.
 * - `pending` past REPAIR_AFTER_MS: a brand record that reads this part is made `active`; one that
 *   still reads the part in `was` goes back to it; one that is missing, disconnected or reads
 *   something else is removed (and the brand side then ends a record left reading it).
 * - `ending`: a connected brand record is ended, then the entry removed; a disconnected or missing
 *   one has its entry removed. Ending is always safe to finish, so it doesn't wait.
 * A read error skips that part this time. `active` parts are left alone here.
 */
export async function repairParts(conn: OrganisationConnection, opts: { by: string; now: Date }, stores: OrganisationStores = {}): Promise<Array<{ tenantId: string; useId: string; outcome: RepairOutcome }>> {
  const at = opts.now.toISOString();
  const source: SourceRef = { organisationId: conn.organisationId, connectionId: conn.id, region: conn.region };
  const out: Array<{ tenantId: string; useId: string; outcome: RepairOutcome }> = [];
  for (const part of conn.parts) {
    if (part.state === "active") continue;
    if (part.state === "pending" && opts.now.getTime() - Date.parse(part.stateSince) < REPAIR_AFTER_MS) {
      out.push({ tenantId: part.tenantId, useId: part.useId, outcome: "skipped" });
      continue;
    }
    const rec = await brandRecord(part, stores);
    if (rec === undefined) {
      out.push({ tenantId: part.tenantId, useId: part.useId, outcome: "skipped" });
      continue;
    }
    const live = rec !== null && rec.status === "connected" && sameSource(rec, source);
    let outcome: RepairOutcome = "skipped";
    try {
      if (part.state === "ending") {
        if (live) {
          const brandStore = regionStore(part.region, stores);
          await brandStore.runTransaction(async (txn) => {
            const extra = await partSettingStage({ tenantId: part.tenantId, region: part.region }, { kind: "end", useId: part.useId }, part.endedBy ?? opts.by, at, END_MESSAGES.repaired!)(txn, brandStore);
            const p = await prepareDataConnectionChange({ tenantId: part.tenantId, region: part.region, source: "system" }, part.useId, endedPlan(part.endedBy ?? opts.by, at, "part_ended"), txn, brandStore, {
              part: true,
            });
            p.stage();
            if (extra.ok && p.result.ok) extra.stage();
          });
        }
        outcome = (await removePartEntry(source, part.tenantId, part.useId, { by: opts.by, at, code: "repaired" }, stores)) ? "finished" : "skipped";
      } else {
        const decide = (p: ConnectionPart): { next: ConnectionPart | null; outcome: RepairOutcome } | null => {
          if (live && rec!.account === p.account) return { next: { ...p, state: "active", stateSince: at, was: null }, outcome: "activated" };
          if (live && p.was && rec!.account === p.was) return { next: { ...p, state: "active", stateSince: at, account: p.was, was: null }, outcome: "put_back" };
          return { next: null, outcome: "removed" };
        };
        const r = await changeOrganisationConnection(
          source.organisationId,
          source.connectionId,
          source.region,
          (cur) => {
            const p = cur.parts.find((x) => x.useId === part.useId && x.tenantId === part.tenantId);
            // Moved on since it was read: leave it to the next run.
            if (!p || p.state !== "pending" || p.stateSince !== part.stateSince) return null;
            const d = decide(p);
            if (!d) return null;
            outcome = d.outcome;
            return { patch: { parts: replacePart(cur.parts, p.useId, d.next) }, activity: [{ kind: "part_repaired", by: opts.by, at, code: d.outcome, tenantId: p.tenantId }] };
          },
          stores,
        );
        if (!r.ok) outcome = "skipped";
      }
    } catch {
      outcome = "skipped";
    }
    out.push({ tenantId: part.tenantId, useId: part.useId, outcome });
  }
  return out;
}
