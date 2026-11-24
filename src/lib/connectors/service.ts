import { randomBytes } from "node:crypto";
import { z } from "zod";
import { changeDataConnection, createDataConnection, endPart, forTenant, isRateLimited, type ActivityWrite, type ChangePlan, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { REGION_CONFIGS } from "@/lib/tenant/region";
import type { Region } from "@/lib/types/tenant";
import { meaningsOf } from "@/lib/metrics/meanings";
import { ConnectionGrantSchema, freshCollect, type ActivityKind, type ConnectionGrant, type ConnectionServiceAccount, type DataConnection } from "@/lib/types/dataConnection";
import { eraseConnectionData, pendingWith, type SearchIndexOf } from "./erase";
import { can, feedsPlanning, grantsCode, normaliseGrants, type ConnectorActor } from "./grants";
import { searchConsoleManifest } from "./manifests/searchConsole";
import { stopPlanningFrom } from "./signals/reconcile";
import { COLLECT_FAILED_DAYS, healthAfterFailure, healthAfterSuccess, healthyAt, isCallPaused, shownState } from "./health";
import { ACCOUNT_HOOKS, VERIFY_HOOKS } from "./handlers";
import type { ConnectorAccount, HookFailure } from "./handlers/types";
import { checkLiveRequest, lagWords, readLive, type LiveAnswer } from "./live";
import { collectedStream, keepsWords, shareMethod, tokenMethod, type ConnectMethodName, type ConnectorIcon, type ConnectorManifest } from "./manifest";
import { addDays, daysIn, laterDay, todayIn } from "./period";
import { oldestAlive } from "./snapshots";
import { connectorMessage, productName, sourceBrokenMessage, tokenRefusedMessage, type ConnectorErrorCode } from "./messages";
import { getConnector, knownConnector, listConnectors, readyMethods } from "./registry";
import type { ConnectorFetchDeps } from "./safeFetch";
import { isConnectorsChatEnabled, isConnectorsCollectEnabled, isGoogleRevokeEnabled } from "./flags";
import { revokeGoogleToken } from "./google";
import { createShareAccount, deleteShareAccount, forgetShareTokens, identitiesProject, projectOfShareAccount, shareAccessToken, type ShareDeps, type ShareResult } from "./shareAccess";
import { PartCache, partFactsOf, partFailure, sourceToken, storesOf, type PartFacts, type PartReads, type SourceDeps } from "./sources";
import { freshAccessToken, REFRESH_SLOT } from "./tokenKeeper";
import { isVaultConfigured, openConnectorSecret, sealConnectorSecret, VaultOpenError, type SealedSecret } from "./vault";

/**
 * What the connector routes do (ADR-0011), each returning a result the route turns into a
 * response. Every function takes the server's TenantContext and the acting person, checks the
 * grants table first, reaches data only through forTenant and the connected data writer, and
 * calls providers only through safe fetch. Secrets are opened only for the call that needs them
 * and never leave here.
 */

export interface ServiceDeps extends ConnectorFetchDeps, SourceDeps, ShareDeps {
  db?: FirestoreLike;
  newId?: () => string;
  /** The brand's search index, for erasing a connection's searches (tests pass an in-memory one). */
  searchIndex?: SearchIndexOf;
}

export type ServiceResult<T> = { ok: true; status: 200 | 201; value: T } | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 502 | 503; error: string; message?: string };

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** The most connections a list reads for one brand. */
const LIST_LIMIT = 200;

/** `dcn_` and 20 random base32 characters. */
export function newDataConnectionId(): string {
  const bytes = randomBytes(20);
  let out = "dcn_";
  for (let i = 0; i < 20; i++) out += BASE32[bytes[i]! & 31];
  return out;
}

function refuse(status: 400 | 403 | 404 | 409 | 429 | 502 | 503, error: string, message?: string): ServiceResult<never> {
  return { ok: false, status, error, ...(message ? { message } : {}) };
}

const CONFLICTS: ReadonlySet<ConnectorErrorCode> = new Set([
  "paused",
  "secret_unopenable",
  "disconnected",
  "signin_refused",
  "account_needed",
  "share_not_visible",
  "share_access_lost",
  "share_pending",
  "share_limit",
  "org_share_limit",
  "managed_by_organisation",
  "part_ended",
  "source_broken",
  "source_paused",
  "sharing_off",
]);
const UNCONFIGURED: ReadonlySet<ConnectorErrorCode> = new Set(["vault_unconfigured", "signin_unconfigured", "share_unconfigured", "share_quota"]);

/**
 * A provider or vault failure: busy is 429; a pause, a dead token or sign in, no site picked yet,
 * a shared address that can't see the property yet, or a brand holding all the shared addresses
 * it may 409; this copy missing a key, a Google
 * client or its identities project, or that project being full, 503; the rest 502.
 */
export function providerRefusal(code: ConnectorErrorCode, about?: { name: string; chat: boolean }): ServiceResult<never> {
  const status = code === "busy" ? 429 : CONFLICTS.has(code) ? 409 : UNCONFIGURED.has(code) ? 503 : 502;
  return refuse(status, code, connectorMessage(code, about));
}

/** A refusal while connecting, before anything is saved: a turned down token names its tool. */
function connectingRefusal(m: ConnectorManifest, code: ConnectorErrorCode): ServiceResult<never> {
  const r = providerRefusal(code);
  return code === "token_refused" && !r.ok ? { ...r, message: tokenRefusedMessage(m.name, "connecting", isConnectorsChatEnabled()) } : r;
}

/** A connection's tool and whether Vizzy reads connected data, so its messages can name the tool. */
const aboutOf = (connectorId: string) => ({ name: knownConnector(connectorId)?.name ?? connectorId, chat: isConnectorsChatEnabled() });

/**
 * A stored connection's call refused: a turned down token names its tool, as Check now and the
 * Connected screen do, wherever the refusal comes from (a live read, Vizzy's, or the picker). A
 * part whose organisation's sign in needs attention names the tool, the brand and the organisation,
 * and who can fix it.
 */
const connectionRefusal = (conn: Pick<DataConnection, "connectorId">, code: ConnectorErrorCode, part?: { organisation: string; brand: string } | null) => {
  const r = providerRefusal(code, aboutOf(conn.connectorId));
  if (code !== "source_broken" || !part || r.ok) return r;
  return { ...r, message: sourceBrokenMessage(productName(aboutOf(conn.connectorId).name), part.brand, part.organisation) };
};

/** Refused for a brand's part: its organisation's owners manage what it reads and how it signs in. */
const managedByOrganisation = () => providerRefusal("managed_by_organisation");

/**
 * A shared connection's failures in its own words: Google turning its address down means the
 * property isn't shared with it (yet), and an API or permission missing is the identities project.
 */
const SHARE_CODES: Partial<Record<ConnectorErrorCode, ConnectorErrorCode>> = {
  account_refused: "share_not_visible",
  token_refused: "share_not_visible",
  signin_refused: "share_not_visible",
  signin_unconfigured: "share_unconfigured",
};

/**
 * A failure in the connection's own words. A shared connection that had read its property before
 * (a property picked, and a call that worked) and now can't see it lost its access: its address
 * was taken off the property, which the daily collect notices the next day. Before it ever worked,
 * it can't see the property yet.
 */
export function codeFor(conn: Pick<DataConnection, "method" | "account" | "health">, code: ConnectorErrorCode): ConnectorErrorCode {
  if (conn.method !== "share_access") return code;
  const mapped = SHARE_CODES[code] ?? code;
  return mapped === "share_not_visible" && conn.account && conn.health.lastOkAt ? "share_access_lost" : mapped;
}

function forMethod<T extends { ok: boolean }>(conn: Pick<DataConnection, "method" | "account" | "health">, r: T): T {
  if (r.ok || conn.method !== "share_access") return r;
  const failed = r as T & { code: ConnectorErrorCode };
  return { ...failed, code: codeFor(conn, failed.code) };
}

const nowOf = (deps: ServiceDeps) => deps.now ?? new Date();
export const byOf = (actor: ConnectorActor) => (actor.kind === "agent" ? `agent:${actor.agent}` : actor.uid || "system");

// --- What people see ---------------------------------------------------------------------------

export interface ConnectorListing {
  id: string;
  name: string;
  /** The manifest's two letters for its tile, when it gives them. */
  initials?: string;
  /** Its own marks (files on this site), when the manifest has them; else the tile shows the letters. */
  icon?: ConnectorIcon;
  summary: string;
  category: string;
  connect: ConnectorManifest["connect"];
  /** The sign-in methods this copy can use now (Sign in with Google needs its client). */
  ready: ConnectMethodName[];
  shares: ConnectorManifest["shares"];
  produces: Array<{
    stream: string;
    description: string;
    shape: string;
    measures: Array<{ key: string; name: string; definition: string; caveat?: string }>;
    lag: string;
    liveBy: string[];
    /** What is kept of it each day and for how long, while collected numbers are on; else null. */
    collect: string | null;
  }>;
  uses: ConnectorManifest["uses"];
  disconnect: string;
}

/** A manifest as Browse and Listing show it: everything public, nothing about a connection. */
export function listingOf(m: ConnectorManifest): ConnectorListing {
  return {
    id: m.id,
    name: m.name,
    ...(m.initials ? { initials: m.initials } : {}),
    ...(m.icon ? { icon: m.icon } : {}),
    summary: m.summary,
    category: m.category,
    connect: m.connect,
    ready: readyMethods(m),
    shares: m.shares,
    produces: m.produces.map((p) => ({
      stream: p.stream,
      description: p.description,
      shape: p.shape,
      measures: Object.entries(meaningsOf(p.measures)).map(([key, mm]) => ({ key, name: mm!.name, definition: mm!.definition, ...(mm!.caveat ? { caveat: mm!.caveat } : {}) })),
      lag: lagWords(p.lagDays),
      liveBy: p.liveBy,
      collect: p.collect && isConnectorsCollectEnabled() ? p.collect.where : null,
    })),
    uses: m.uses,
    disconnect: m.disconnect,
  };
}

/**
 * How far a connection's numbers are collected (CONNECTORS_COLLECT_ENABLED), for its admins: the
 * days kept, in the provider's zone, how final they are, what each day keeps, and whether a day is
 * late or collecting is failing or held.
 */
export interface CollectView {
  lastDay: string | null;
  finalThrough: string | null;
  /** The oldest day kept now: never one past its time to live (null when none is left). */
  keptFrom: string | null;
  days: number;
  keepDays: number;
  filled: boolean;
  timeZone: string | null;
  /** When a day arrives, from the manifest. */
  lag: string;
  /** What each kept day holds. */
  keeps: string;
  /** The newest day's busiest grouping: how many rows the provider listed and how many were kept. */
  kept: { day: string; by: string; seen: number; rows: number; more: boolean } | null;
  /** A day the provider hasn't finished yet though it usually has by now (Search Console). */
  waitingFor: string | null;
  /** Collecting has failed every day since then, for COLLECT_FAILED_DAYS or more: it counts as stopped. */
  failedSince: string | null;
  /** Collecting failed then, less than COLLECT_FAILED_DAYS ago: it is retried on its own, only noted. */
  failedOn: string | null;
  holdReason: string | null;
  /** Its numbers can suggest articles (pages or searches), when members and Vizzy may read it. */
  feedsPlanning: boolean;
}

/** A connection's collect state as its admins see it, or null when its connector collects nothing. */
export function collectViewOf(conn: DataConnection, now: Date): CollectView | null {
  const m = knownConnector(conn.connectorId);
  const stream = m ? collectedStream(m) : null;
  if (!stream) return null;
  const c = conn.collect ?? freshCollect();
  const keepDays = stream.collect.keepDays;
  // As explicit reads do: never a day already past its time to live (a connection that stopped
  // collecting weeks ago keeps fewer days, and none once its last day is gone too).
  const oldest = c.lastDay && c.backfilledTo ? laterDay(laterDay(c.backfilledTo, addDays(c.lastDay, -(keepDays - 1))), oldestAlive(now, keepDays)) : null;
  const keptFrom = oldest && c.lastDay && oldest <= c.lastDay ? oldest : null;
  const zone = c.timeZone ?? stream.timeZone ?? null;
  const today = zone ? todayIn(now, zone) : null;
  const waitingFor = stream.collect.waitsForFinal && c.filled && c.lastDay && today && daysIn(c.lastDay, today) - 1 >= 3 ? addDays(c.lastDay, 1) : null;
  // One rule with Review: stopped only after COLLECT_FAILED_DAYS of failing; before that, a note.
  const failedLong = c.failedSince !== null && now.getTime() - Date.parse(c.failedSince) >= COLLECT_FAILED_DAYS * 86_400_000;
  return {
    lastDay: c.lastDay,
    finalThrough: c.finalThrough,
    keptFrom,
    days: keptFrom && c.lastDay ? daysIn(keptFrom, c.lastDay) : 0,
    keepDays,
    filled: c.filled,
    timeZone: zone,
    lag: stream.collect.lag,
    keeps: keepsWords(stream.collect),
    kept: c.kept,
    waitingFor,
    failedSince: failedLong ? c.failedSince : null,
    failedOn: c.failedSince && !failedLong ? c.failedSince : null,
    holdReason: c.holdUntil && Date.parse(c.holdUntil) > now.getTime() ? c.holdReason : c.holdReason === "no_data" ? "no_data" : null,
    feedsPlanning: stream.collect.by.some((b) => b !== "day"),
  };
}

export interface ConnectionView {
  id: string;
  connectorId: string;
  connectorName: string;
  /** The connector's tile: its marks, or the two letters its manifest gives, when it has them. */
  connectorIcon?: ConnectorIcon;
  connectorInitials?: string;
  /** False when this copy has the connector switched off: the connection stays, unread. */
  connectorOn: boolean;
  label: string;
  status: DataConnection["status"];
  /** `since`: when the failures in a row began, or null. */
  health: { state: ReturnType<typeof shownState>; lastOkAt: string | null; lastCheckedAt: string | null; message: string | null; pausedUntil: string | null; since?: string | null };
  /** True after a sign in until an admin picks the site or property it reads. */
  needsAccount: boolean;
  canReadLive: boolean;
  /** The last day collected, for anyone who may read it, while collected numbers are on; else null. */
  collectedTo: string | null;
  /**
   * A brand's part of its organisation's connection (Connectors 3, a record with a `source`): who
   * gives it, and whether it reads now. It names only this brand and its own organisation, never
   * the sign in, its Google address, what it can see or another brand's part.
   */
  part?: PartView;
  /** Admins only. */
  details?: {
    method: DataConnection["method"];
    account: string;
    ownerUid: string;
    grants: ConnectionGrant[];
    recent: DataConnection["recent"];
    /** Which secrets are kept and when they were sealed, never the secrets. */
    secrets: Array<{ slot: string; sealedAt: string }>;
    /** A shared connection's Google address, to add to the property; null for the other methods. */
    serviceAccount: { email: string; deletedAt: string | null } | null;
    pausedAt: string | null;
    pausedBy: string | null;
    createdAt: string;
    updatedAt: string;
    disconnectedAt: string | null;
    /** How far its numbers are collected, while collected numbers are on; null otherwise. */
    collect: CollectView | null;
  };
}

export interface PartView {
  /** The organisation that gives it, and this brand, by name; null when they couldn't be read. */
  organisation: string | null;
  brand: string | null;
  reads: PartReads;
  /** When its organisation's sign in stopped working (`source`). */
  since: string | null;
  /** Where the sign in is kept, and where this brand keeps its numbers, by name. */
  keptIn: string;
  region: string;
  /**
   * How it ended, from its own activity, once it is disconnected: `left` (the brand left the
   * organisation), `part_ended` (taken back), `stopped_using`, or `disconnected` (the organisation
   * disconnected its connection).
   */
  ended: { why: string; at: string } | null;
}

const regionLabel = (r: Region): string => REGION_CONFIGS[r]?.displayName ?? r;

/** Codes a part records while its organisation's connection can't serve it; stale once it reads again. */
const SOURCE_CODES: ReadonlySet<string> = new Set(["source_broken", "source_paused", "sharing_off", "part_ended"]);

/** A part's view from what partFactsOf read: the brand's region is the server's, never a request's. */
export function partViewOf(conn: DataConnection, brandRegion: Region, facts: PartFacts): PartView {
  const end = conn.status === "connected" ? null : (conn.recent.find((e) => e.kind === "disconnected") ?? null);
  return {
    organisation: facts.organisation,
    brand: facts.brand,
    reads: facts.reads,
    since: facts.since,
    keptIn: regionLabel(conn.source?.region ?? brandRegion),
    region: regionLabel(brandRegion),
    ended: end ? { why: end.code ?? "disconnected", at: end.at } : conn.status === "connected" ? null : conn.disconnectedAt ? { why: "disconnected", at: conn.disconnectedAt } : null,
  };
}

/**
 * The health a part shows: its organisation's sign in needing attention reads as broken from then,
 * its owners' pause as paused, and a code the part recorded while its source couldn't serve it is
 * dropped once it reads again. The brand's own pause, and a failure of its own part, stay as they are.
 */
function partHealth(conn: DataConnection, part: PartView, health: ConnectionView["health"]): ConnectionView["health"] {
  if (health.state === "paused" || health.state === "broken") return health;
  if (part.reads === "source") return { ...health, state: "broken", since: part.since, message: connectorMessage("source_broken") };
  if (part.reads === "paused") return { ...health, state: "paused", message: connectorMessage("source_paused") };
  if ((part.reads === "live" || part.reads === "off") && health.state === "check" && conn.health.lastErrorCode && SOURCE_CODES.has(conn.health.lastErrorCode)) {
    return { ...health, state: "ok", message: null, since: null };
  }
  return health;
}

/**
 * A connection as this actor may see it: name and health for anyone allowed to see it, the rest for
 * admins. A brand's part (`part`, from partFactsOf) that partLive refuses (its organisation no
 * longer gives it, sharing is off, a give not finished, or a read that failed) reads nothing: no
 * live read, and no collected line, before the erase. `partLive: false` alone says the same
 * without the part's words.
 */
export function viewOf(conn: DataConnection, actor: ConnectorActor, now: Date, opts: { partLive?: boolean; part?: PartView | null } = {}): ConnectionView {
  const part = conn.source ? (opts.part ?? null) : null;
  const live = opts.partLive !== false && (!part || part.reads === "live" || part.reads === "source" || part.reads === "paused");
  const known = knownConnector(conn.connectorId);
  const view: ConnectionView = {
    id: conn.id,
    connectorId: conn.connectorId,
    connectorName: known?.name ?? conn.connectorId,
    ...(known?.icon ? { connectorIcon: known.icon } : {}),
    ...(known?.initials ? { connectorInitials: known.initials } : {}),
    connectorOn: getConnector(conn.connectorId) !== null,
    label: conn.label,
    status: conn.status,
    health: {
      state: shownState(conn, now),
      lastOkAt: conn.health.lastOkAt,
      lastCheckedAt: conn.health.lastCheckedAt,
      message: conn.health.lastErrorCode ? connectorMessage(conn.health.lastErrorCode, { ...aboutOf(conn.connectorId), since: conn.health.since ?? null }) : null,
      pausedUntil: conn.health.pausedUntil,
      since: conn.health.since ?? null,
    },
    needsAccount: conn.status === "connected" && !conn.account,
    canReadLive: live && conn.status === "connected" && !!conn.account && can(actor, "read_live", conn.grants),
    collectedTo: null,
  };
  if (part) {
    view.part = part;
    view.health = partHealth(conn, part, view.health);
  }
  // A part that reads nothing shows nothing it collected, to anyone, until the erase.
  const collect = isConnectorsCollectEnabled() && conn.status === "connected" && live ? collectViewOf(conn, now) : null;
  if (collect && view.canReadLive) view.collectedTo = collect.lastDay;
  if (can(actor, "see_details", conn.grants)) {
    view.details = {
      method: conn.method,
      account: conn.account,
      ownerUid: conn.ownerUid,
      grants: conn.grants,
      recent: conn.recent,
      secrets: Object.entries(conn.secrets).map(([slot, s]) => ({ slot, sealedAt: s.sealedAt })),
      serviceAccount: conn.serviceAccount ? { email: conn.serviceAccount.email, deletedAt: conn.serviceAccount.deletedAt } : null,
      pausedAt: conn.pausedAt,
      pausedBy: conn.pausedBy,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
      disconnectedAt: conn.disconnectedAt,
      collect,
    };
  }
  return view;
}

/** Each part's view (partLive, then its source's state and the names), with one cache for the request. */
async function partViews(ctx: TenantContext, rows: readonly DataConnection[], deps: ServiceDeps): Promise<Map<string, PartView>> {
  const out = new Map<string, PartView>();
  const shared = { ...deps, partCache: deps.partCache ?? new PartCache() };
  for (const c of rows) {
    if (!c.source) continue;
    const facts = await partFactsOf(ctx, c, shared);
    if (facts) out.set(c.id, partViewOf(c, ctx.region, facts));
  }
  return out;
}

/** One connection as this actor may see it, with its part's words when it is a brand's part. */
async function viewFor(ctx: TenantContext, conn: DataConnection, actor: ConnectorActor, deps: ServiceDeps): Promise<ConnectionView> {
  if (!conn.source) return viewOf(conn, actor, nowOf(deps));
  const parts = await partViews(ctx, [conn], deps);
  return viewOf(conn, actor, nowOf(deps), { part: parts.get(conn.id) ?? null, partLive: parts.has(conn.id) ? undefined : false });
}

/** Browse and the brand's connections, newest first, as this actor may see them. */
export async function listForActor(ctx: TenantContext, actor: ConnectorActor, deps: ServiceDeps = {}): Promise<ServiceResult<{ connectors: ConnectorListing[]; connections: ConnectionView[] }>> {
  const now = nowOf(deps);
  const rows = (await forTenant(ctx, deps.db).dataConnections.find({ limit: LIST_LIMIT })).filter((c) => can(actor, "see", c.grants));
  const parts = await partViews(ctx, rows, deps);
  const connections = rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => viewOf(c, actor, now, { part: parts.get(c.id) ?? null, partLive: c.source && !parts.has(c.id) ? false : undefined }));
  return { ok: true, status: 200, value: { connectors: listConnectors().map(listingOf), connections } };
}

async function load(ctx: TenantContext, id: string, deps: ServiceDeps): Promise<DataConnection | null> {
  return forTenant(ctx, deps.db).dataConnections.getById(id);
}

/** One connection, or 404 for an id this brand doesn't have or this actor may not see. */
export async function getForActor(ctx: TenantContext, actor: ConnectorActor, id: string, deps: ServiceDeps = {}): Promise<ServiceResult<ConnectionView>> {
  const conn = await load(ctx, id, deps);
  if (!conn || !can(actor, "see", conn.grants)) return refuse(404, "not_found");
  return { ok: true, status: 200, value: await viewFor(ctx, conn, actor, deps) };
}

// --- Connect -----------------------------------------------------------------------------------

export const ConnectBodySchema = z
  .object({
    fields: z.record(z.string().max(64), z.string().max(4096)).refine((f) => Object.keys(f).length <= 10, "too many fields"),
    label: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

/**
 * The typed fields, checked against the manifest: all of them to connect, or only the secrets to
 * check a token before connecting. A refusal names the manifest's own labels for the fields that
 * failed, never a value, and never echoes a key the manifest doesn't have.
 */
export function checkFields(
  m: ConnectorManifest,
  raw: Record<string, string>,
  which: "all" | "secrets" = "all",
): { ok: true; values: Record<string, string> } | { ok: false; labels: string[] } {
  const method = tokenMethod(m);
  if (!method) return { ok: false, labels: [] };
  const fields = method.fields.filter((f) => which === "all" || f.secret);
  const labels: string[] = [];
  const values: Record<string, string> = {};
  for (const f of fields) {
    const v = (raw[f.key] ?? "").trim();
    if (v.length < f.minLength || v.length > f.maxLength || !new RegExp(f.pattern).test(v)) labels.push(f.label);
    else values[f.key] = v;
  }
  if (Object.keys(raw).some((k) => !fields.some((f) => f.key === k))) labels.push("the fields sent: one isn't asked for here");
  return labels.length ? { ok: false, labels } : { ok: true, values };
}

/** A label as typed, with control characters and angle brackets taken out; the fallback when nothing is left. */
export function cleanLabel(label: string | undefined, fallback: string): string {
  const cleaned = (label ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
  return cleaned || fallback;
}

/**
 * Connect with typed fields (token_fields). The token is checked with the manifest's one verify
 * request before anything is saved; then the record and its "connected" activity are written
 * together, with each secret sealed under the vault. Admins only.
 */
export async function connect(ctx: TenantContext, actor: ConnectorActor, connectorId: string, body: unknown, deps: ServiceDeps = {}): Promise<ServiceResult<ConnectionView>> {
  const m = getConnector(connectorId);
  if (!m) return refuse(404, "not_found");
  if (!can(actor, "connect")) return refuse(403, "forbidden");
  const method = tokenMethod(m);
  if (!method) return refuse(400, "method_not_supported");
  const parsed = ConnectBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const fields = checkFields(m, parsed.data.fields);
  if (!fields.ok) return { ok: false, status: 400, error: "invalid_fields", message: `Check ${fields.labels.join(", and ")}.` };
  if (!isVaultConfigured()) return providerRefusal("vault_unconfigured");

  const account = fields.values[method.account]!;
  const existing = await forTenant(ctx, deps.db).dataConnections.find({
    where: [
      ["connectorId", "==", m.id],
      ["account", "==", account],
      ["status", "==", "connected"],
    ],
    limit: 1,
  });
  if (existing.length) return refuse(409, "already_connected", "This account is connected already. Check or disconnect it there.");

  const now = nowOf(deps);
  const id = (deps.newId ?? newDataConnectionId)();
  const health = healthyAt(now);
  const verify = VERIFY_HOOKS[m.verify.hook];
  if (!verify) return refuse(503, "connector_unavailable");
  const result = await verify({ manifest: m, connection: { id, tenantId: ctx.tenantId, pausedAt: null, health }, account, token: fields.values[method.auth.field]! }, deps);
  if (!result.ok) return connectingRefusal(m, result.code);

  const secrets: Record<string, SealedSecret> = {};
  for (const f of method.fields) if (f.secret) secrets[f.key] = sealConnectorSecret(ctx.tenantId, id, f.key, fields.values[f.key]!, now);
  const at = now.toISOString();
  const conn = await createDataConnection(
    ctx,
    {
      id,
      connectorId: m.id,
      method: "token_fields",
      label: cleanLabel(parsed.data.label, m.name),
      account,
      ownerUid: byOf(actor),
      grants: [],
      secrets,
      health,
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: at,
      updatedAt: at,
      disconnectedAt: null,
      // Collected numbers start on the lane's next run (CONNECTORS_COLLECT_ENABLED).
      collect: freshCollect(at),
    },
    [{ kind: "connected", by: byOf(actor), at }],
    deps.db,
  );
  return { ok: true, status: 201, value: viewOf(conn, actor, now) };
}

// --- Check a token before connecting -----------------------------------------------------------

export const CheckTokenBodySchema = z
  .object({ fields: z.record(z.string().max(64), z.string().max(4096)).refine((f) => Object.keys(f).length <= 10, "too many fields") })
  .strict();

export interface TokenCheck {
  /** What the token can see, for the picker (Cloudflare's zones); [] when it can't list them. */
  accounts: ConnectorAccount[];
  /** The provider listed more than the picker shows: the account can be typed instead. */
  more: boolean;
  /** False when the token can't list them, so the account is typed instead (a Zone ID). */
  listed: boolean;
}

/** Token checks one brand may make for one connector: each is a call with a pasted token. */
const TOKEN_CHECK_LIMIT = { burst: 5, hourly: 30 };

/**
 * The stand in for the connection a token check has none of: safe fetch rate limits its calls
 * under this id for the brand, and it is never paused.
 */
const CHECK_CONNECTION_ID = "check";

/**
 * Check a pasted token before anything is saved, and list what it can see for the picker
 * (Cloudflare's zones, through the manifest's accounts hook). A token that is fine but can't list
 * them answers listed: false, so the account is typed and Connect checks the token with it. Only
 * the secret fields come in; nothing is stored, sealed or written to any log, and the token is
 * used for this one call. Admins only, with the same switch, vault and connector checks as
 * connect, and rate limited per brand.
 */
export async function checkToken(ctx: TenantContext, actor: ConnectorActor, connectorId: string, body: unknown, deps: ServiceDeps = {}): Promise<ServiceResult<TokenCheck>> {
  const m = getConnector(connectorId);
  if (!m) return refuse(404, "not_found");
  if (!can(actor, "connect")) return refuse(403, "forbidden");
  const method = tokenMethod(m);
  const hook = method?.pick && m.hooks.accounts ? ACCOUNT_HOOKS[m.hooks.accounts] : undefined;
  if (!method || !hook) return refuse(400, "method_not_supported");
  const parsed = CheckTokenBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const fields = checkFields(m, parsed.data.fields, "secrets");
  if (!fields.ok) return { ok: false, status: 400, error: "invalid_fields", message: `Check ${fields.labels.join(", and ")}.` };
  if (!isVaultConfigured()) return providerRefusal("vault_unconfigured");

  const limit = deps.limit ?? ((subject: string, config: Parameters<typeof isRateLimited>[1]) => isRateLimited(subject, config));
  if (await limit(ctx.tenantId, { prefix: `connector-check:${m.id}`, burstLimit: TOKEN_CHECK_LIMIT.burst, hourlyLimit: TOKEN_CHECK_LIMIT.hourly })) return providerRefusal("busy");

  const connection = { id: CHECK_CONNECTION_ID, tenantId: ctx.tenantId, pausedAt: null, health: healthyAt(nowOf(deps)) };
  const r = await hook({ manifest: m, connection, account: "", token: fields.values[method.auth.field]! }, deps);
  if (!r.ok) {
    if (r.code === "account_refused") return { ok: true, status: 200, value: { accounts: [], more: false, listed: false } };
    return connectingRefusal(m, r.code);
  }
  return { ok: true, status: 200, value: { accounts: r.accounts, more: r.more, listed: r.accounts.length > 0 } };
}

// --- Calls that use the stored secret ---------------------------------------------------------

/** Who a system job acts as: its activity rows say "system". */
export const SYSTEM: ConnectorActor = { kind: "human", uid: "", role: undefined };

/**
 * Activity kinds kept in the log only, off the record's recent list: Vizzy's reads and the daily
 * collect's rows (the Connected view shows people's changes). Kinds a newer build adds go here too,
 * because an older build's parse throws on a kind it doesn't know on the recent list.
 */
const LOG_ONLY: ReadonlySet<ActivityWrite["kind"]> = new Set(["read", "collected", "erased"]);

/**
 * The activity and health patch for a call's outcome: a live read's, a check's, or the daily
 * collect's (actor SYSTEM), so collect failures land on health exactly as live read failures do.
 */
export function outcomePlan(
  cur: DataConnection,
  outcome: { ok: true } | HookFailure,
  actor: ConnectorActor,
  now: Date,
  onSuccess: ActivityWrite["kind"] | null,
  read?: ActivityWrite["read"],
): ChangePlan {
  const at = now.toISOString();
  if (outcome.ok) {
    const recentOk = cur.health.state === "ok" && cur.health.lastOkAt && now.getTime() - Date.parse(cur.health.lastOkAt) < 10 * 60_000;
    if (!onSuccess && recentOk) return null;
    // Vizzy's reads are logged but kept off the recent list (the Connected view shows people's changes),
    // with what was asked and the days read, never a number or a page.
    return {
      patch: { health: healthAfterSuccess(cur.health, now) },
      activity: onSuccess ? [{ kind: onSuccess, by: byOf(actor), at, ...(LOG_ONLY.has(onSuccess) ? { recent: false, ...(read ? { read } : {}) } : {}) }] : [],
    };
  }
  const next = healthAfterFailure(cur.health, outcome.code, now, outcome.retryAfterSec);
  if (!next) return null;
  const activity: ActivityWrite[] = [{ kind: "failed", by: byOf(actor), at, code: outcome.code }];
  if (next.pausedNow) activity.push({ kind: "paused", by: "system", at, code: outcome.code });
  return { patch: { health: next.health }, activity };
}

type Usable = { ok: true; conn: DataConnection; manifest: ConnectorManifest; token: string } | { ok: false; result: ServiceResult<never> };

/**
 * A connection's token, or why not; `recorded` when the token keeper already wrote the failure on
 * the connection. A part's refusal may name its organisation and brand (`part`), for its words.
 */
export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; code: ConnectorErrorCode; retryAfterSec: number | null; recorded: boolean; part?: { organisation: string; brand: string } | null };

/**
 * The token for a call on a connection, whoever asks: a shared connection's minted for its address
 * (300 seconds, kept only in this server's memory), a Google sign in's kept fresh by the token
 * keeper under its lease, a pasted token opened from the vault. No grant is checked here: the
 * caller checks its own (usable for people and Vizzy; none for the daily collect, a system job).
 * Nothing is written, except by the token keeper when Google ended a sign in.
 *
 * A brand's part of its organisation's connection (a record with a `source`, Connectors 3) is
 * minted through the organisation's connection, after partLive; its own secrets, if any were ever
 * found on it, are never read.
 */
export async function connectionToken(ctx: TenantContext, conn: DataConnection, manifest: ConnectorManifest, by: string, deps: ServiceDeps = {}): Promise<TokenResult> {
  if (conn.source) {
    const r = await sourceToken(ctx, conn, manifest, by, deps);
    return r.ok ? r : { ok: false, code: r.code, retryAfterSec: r.retryAfterSec, recorded: false, part: r.about };
  }
  if (conn.method === "share_access") {
    const kept = await shareToken(conn, manifest, deps);
    return kept.ok ? { ok: true, token: kept.token } : { ok: false, code: kept.code, retryAfterSec: kept.retryAfterSec, recorded: false };
  }
  if (conn.method === "oauth_pkce") {
    const kept = await freshAccessToken(ctx, conn, by, deps);
    return kept.ok ? { ok: true, token: kept.token } : { ok: false, code: kept.code, retryAfterSec: kept.retryAfterSec, recorded: Boolean(kept.recorded) };
  }
  const method = tokenMethod(manifest);
  const sealed = method ? conn.secrets[method.auth.field] : undefined;
  try {
    if (!sealed) throw new VaultOpenError("unopenable");
    return { ok: true, token: openConnectorSecret(ctx.tenantId, conn.id, method!.auth.field, sealed) };
  } catch (err) {
    if (!(err instanceof VaultOpenError)) throw err;
    return { ok: false, code: "secret_unopenable", retryAfterSec: null, recorded: false };
  }
}

/** A token for a shared connection's address, with the connector's one read scope. */
async function shareToken(conn: DataConnection, manifest: ConnectorManifest, deps: ServiceDeps): Promise<ShareResult<{ token: string }>> {
  const share = shareMethod(manifest);
  const sa = conn.serviceAccount;
  if (!share) return { ok: false, code: "share_unconfigured", retryAfterSec: null };
  if (!sa || sa.deletedAt) return { ok: false, code: "disconnected", retryAfterSec: null };
  if (!identitiesProject()) return { ok: false, code: "share_unconfigured", retryAfterSec: null };
  return shareAccessToken(sa, share.scopes[0]!, deps);
}

/**
 * Load a connection for a call: allowed, connected, its connector on, not paused, a site picked
 * for a live read, and its token: a pasted one opened, or a Google sign in's kept fresh.
 */
async function usable(ctx: TenantContext, actor: ConnectorActor, id: string, action: "check" | "read_live", deps: ServiceDeps): Promise<Usable> {
  const conn = await load(ctx, id, deps);
  if (!conn || !can(actor, "see", conn.grants)) return { ok: false, result: refuse(404, "not_found") };
  if (!can(actor, action, conn.grants)) return { ok: false, result: refuse(403, action === "read_live" ? "no_read_grant" : "forbidden") };
  if (conn.status !== "connected") return { ok: false, result: providerRefusal("disconnected") };
  const manifest = getConnector(conn.connectorId);
  if (!manifest) return { ok: false, result: refuse(404, "connector_off") };
  const now = nowOf(deps);
  if (isCallPaused(conn, now)) return { ok: false, result: providerRefusal("paused") };
  if (action === "read_live" && !conn.account) return { ok: false, result: providerRefusal("account_needed") };
  const kept = await connectionToken(ctx, conn, manifest, byOf(actor), deps);
  if (kept.ok) return { ok: true, conn, manifest, token: kept.token };
  if (!kept.recorded) {
    await changeDataConnection(ctx, conn.id, (cur) => outcomePlan(cur, { ok: false, code: kept.code, retryAfterSec: kept.retryAfterSec }, actor, now, null), deps.db);
  }
  return { ok: false, result: kept.code === "secret_unopenable" ? providerRefusal("secret_unopenable") : connectionRefusal(conn, kept.code, kept.part) };
}

export interface CheckOutcome {
  connection: ConnectionView;
  check: { ok: boolean; code: ConnectorErrorCode | null; message: string | null };
}

/** Check now: run the verify request and record the outcome on the connection's health. Admins only. */
export async function check(ctx: TenantContext, actor: ConnectorActor, id: string, deps: ServiceDeps = {}): Promise<ServiceResult<CheckOutcome>> {
  const u = await usable(ctx, actor, id, "check", deps);
  if (!u.ok) return u.result;
  const now = nowOf(deps);
  const verify = VERIFY_HOOKS[u.manifest.verify.hook];
  if (!verify) return refuse(503, "connector_unavailable");
  const verified = forMethod(u.conn, await verify({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token }, deps));
  if (!verified.ok && verified.code === "busy") return providerRefusal("busy");
  // A part's sign in turned down outright is its organisation's, not this brand's.
  const outcome = verified.ok ? verified : { ...verified, code: await partFailure(u.conn, verified.code, byOf(actor), deps) };
  const r = await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, outcome, actor, now, "verified"), deps.db);
  const conn = r.ok ? r.connection : r.why === "unchanged" ? r.connection : u.conn;
  const view = await viewFor(ctx, conn, actor, { ...deps, now });
  // A part whose organisation's sign in needs attention says who can fix it, by name.
  const names = view.part?.organisation && view.part.brand ? { organisation: view.part.organisation, brand: view.part.brand } : null;
  const message = (code: ConnectorErrorCode) => {
    const refusal = connectionRefusal(u.conn, code, names);
    return !refusal.ok && refusal.message ? refusal.message : connectorMessage(code, aboutOf(u.conn.connectorId));
  };
  return {
    ok: true,
    status: 200,
    value: {
      connection: view,
      check: outcome.ok ? { ok: true, code: null, message: null } : { ok: false, code: outcome.code, message: message(outcome.code) },
    },
  };
}

/**
 * A live read, for an admin, a member with the read grant, or Vizzy with its grant. Records
 * failures on health; `record` also logs a successful read (Vizzy's reads are logged as "read").
 */
export async function readLiveFor(
  ctx: TenantContext,
  actor: ConnectorActor,
  id: string,
  rawQuery: unknown,
  deps: ServiceDeps = {},
  record: ActivityKind | null = null,
): Promise<ServiceResult<LiveAnswer>> {
  const u = await usable(ctx, actor, id, "read_live", deps);
  if (!u.ok) return u.result;
  const now = nowOf(deps);
  const checked = checkLiveRequest(u.manifest, rawQuery, now);
  if (!checked.ok) return refuse(400, checked.error);
  const q = checked.query;
  const read0 = forMethod(u.conn, await readLive({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token, query: q }, deps));
  if (!read0.ok && read0.code === "busy") return providerRefusal("busy");
  // A part's sign in turned down outright is its organisation's, not this brand's.
  const r = read0.ok ? read0 : { ...read0, code: await partFailure(u.conn, read0.code, byOf(actor), deps) };
  const read = r.ok
    ? { stream: q.stream, by: q.by, from: r.answer.period.from, to: r.answer.period.to, timeZone: r.answer.period.timeZone, limit: q.limit, period: q.period ?? null, pageFilter: q.page !== undefined }
    : undefined;
  await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, r.ok ? { ok: true } : r, actor, now, record, read), deps.db);
  if (!r.ok) return connectionRefusal(u.conn, r.code);
  return { ok: true, status: 200, value: r.answer };
}

// --- Picking what a signed in connection reads -------------------------------------------------

export interface AccountsList {
  accounts: ConnectorAccount[];
  /** The provider listed more than the picker shows. */
  more: boolean;
  /** What the connection reads now, or "" when nothing is picked yet. */
  current: string;
}

/**
 * The sites or properties a signed in connection can see, for the picker (Search Console's
 * sites.list, unverified sites left out). Admins only. Nothing is stored.
 */
export async function listAccounts(ctx: TenantContext, actor: ConnectorActor, id: string, deps: ServiceDeps = {}): Promise<ServiceResult<AccountsList>> {
  // A part's list is its organisation's: a brand admin never sees what else the sign in can read.
  const part = await load(ctx, id, deps);
  if (part?.source && can(actor, "see", part.grants)) return managedByOrganisation();
  const u = await usable(ctx, actor, id, "check", deps);
  if (!u.ok) return u.result;
  const hook = u.manifest.hooks.accounts ? ACCOUNT_HOOKS[u.manifest.hooks.accounts] : undefined;
  // A token connection picks its account before it is saved (checkToken) and never changes it here.
  if (!hook || u.conn.method === "token_fields") return refuse(400, "method_not_supported");
  const now = nowOf(deps);
  const r = forMethod(u.conn, await hook({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token }, deps));
  if (!r.ok) {
    if (r.code !== "busy") await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, r, actor, now, null), deps.db);
    return connectionRefusal(u.conn, r.code);
  }
  await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, { ok: true }, actor, now, null), deps.db);
  return { ok: true, status: 200, value: { accounts: r.accounts, more: r.more, current: u.conn.account } };
}

export const PickAccountBodySchema = z.object({ account: z.string().trim().min(1).max(2000) }).strict();

/**
 * Pick the site or property a signed in connection reads. It must be one the sign in can see now
 * (the verify request runs with it), and not already read by another of the brand's connections.
 * A refused pick changes nothing on the connection. Admins only.
 */
export async function pickAccount(ctx: TenantContext, actor: ConnectorActor, id: string, body: unknown, deps: ServiceDeps = {}): Promise<ServiceResult<ConnectionView>> {
  const parsed = PickAccountBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const conn = await load(ctx, id, deps);
  if (!conn || !can(actor, "see", conn.grants)) return refuse(404, "not_found");
  if (!can(actor, "connect", conn.grants)) return refuse(403, "forbidden");
  // A part changes only through its organisation (the part change in src/lib/tenant).
  if (conn.source) return managedByOrganisation();
  if (conn.method === "token_fields") return refuse(400, "method_not_supported");
  const u = await usable(ctx, actor, id, "check", deps);
  if (!u.ok) return u.result;
  const account = parsed.data.account;
  const verify = VERIFY_HOOKS[u.manifest.verify.hook];
  if (!verify) return refuse(503, "connector_unavailable");
  const checked = await verify({ manifest: u.manifest, connection: u.conn, account, token: u.token }, deps);
  if (!checked.ok) {
    if (checked.code === "account_refused") return refuse(400, "account_refused", "That site or property isn't one this connection can read. Pick one from the list.");
    return connectionRefusal(u.conn, codeFor(u.conn, checked.code));
  }
  const existing = await forTenant(ctx, deps.db).dataConnections.find({
    where: [
      ["connectorId", "==", u.conn.connectorId],
      ["account", "==", account],
      ["status", "==", "connected"],
    ],
    limit: 3,
  });
  if (existing.some((c) => c.id !== id)) return refuse(409, "already_connected", "Another connection reads this already. Check or disconnect it there.");
  const now = nowOf(deps);
  let leased = false;
  let erase: number[] | null = null;
  const changeLease = randomBytes(12).toString("hex");
  const r = await changeDataConnection(
    ctx,
    id,
    (cur) => {
      const planned = changePropertyPlan(cur, account, { now, by: byOf(actor), leaseId: changeLease });
      leased = planned?.kind === "leased";
      erase = planned?.kind === "plan" ? planned.erase : null;
      return planned?.kind === "plan" ? planned.plan : null;
    },
    deps.db,
  );
  if (!r.ok && r.why === "not_found") return refuse(404, "not_found");
  if (leased) return providerRefusal("busy");
  const old = erase as number[] | null;
  if (r.ok && old) await afterChangeProperty(ctx, id, r.connection, old, changeLease, { by: byOf(actor), now, db: deps.db, searchIndex: deps.searchIndex });
  const after = r.ok && old ? await load(ctx, id, deps) : null;
  return { ok: true, status: 200, value: viewOf(after ?? (r.ok ? r.connection : r.connection), actor, now) };
}

/**
 * Change property's change to a record, for a brand's own connection (pickAccount) and a brand's
 * part (the part change, src/lib/tenant/organisationConnections.ts): take the collect lease, bump
 * the generation and mark the old one for erasing, in this one change, so the new site's numbers
 * never share an id with the old site's; a first pick starts collecting on the lane's next run.
 * Null when it already reads that account or isn't connected; `leased` while a collect run holds it.
 */
export function changePropertyPlan(
  cur: DataConnection,
  account: string,
  opts: { now: Date; by: string; leaseId: string; code?: string; label?: string },
): { kind: "leased" } | { kind: "plan"; plan: NonNullable<ChangePlan>; erase: number[] | null } | null {
  if (cur.status !== "connected" || cur.account === account) return null;
  const at = opts.now.toISOString();
  const c = cur.collect ?? freshCollect();
  if (cur.account && c.leaseId && c.leaseUntil && Date.parse(c.leaseUntil) > opts.now.getTime()) return { kind: "leased" };
  const collect = cur.account
    ? { ...freshCollect(at, c.gen + 1), erasePending: pendingWith(c.erasePending, [c.gen]), leaseId: opts.leaseId, leaseUntil: new Date(opts.now.getTime() + CHANGE_LEASE_MS).toISOString() }
    : { ...c, nextAt: at };
  return {
    kind: "plan",
    erase: cur.account ? [c.gen] : null,
    plan: {
      patch: { account, health: healthAfterSuccess(cur.health, opts.now), collect, ...(opts.label ? { label: opts.label } : {}) },
      activity: [{ kind: "account_picked", by: opts.by, at, ...(opts.code ? { code: opts.code } : {}) }],
    },
  };
}

/**
 * After Change property: erase the old generation's numbers (a failure stays pending for the lane),
 * then let go of the collect lease and start the new 90 days on the lane's next run.
 */
export async function afterChangeProperty(
  ctx: TenantContext,
  id: string,
  changed: DataConnection,
  old: number[],
  leaseId: string,
  opts: { by: string; now: Date; db?: FirestoreLike; searchIndex?: SearchIndexOf },
): Promise<void> {
  try {
    await eraseConnectionData(ctx, id, changed.collect?.erasePending ?? old, { by: opts.by, now: opts.now, db: opts.db, searchIndex: opts.searchIndex });
  } catch (err) {
    console.warn(`[connectors] erase after Change property failed for ${id}; the lane tries again:`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  const at = opts.now.toISOString();
  await changeDataConnection(ctx, id, (cur) => (cur.collect?.leaseId === leaseId ? { patch: { collect: { ...cur.collect, leaseId: null, leaseUntil: null, nextAt: at } }, activity: [] } : null), opts.db);
}

/** How long Change property holds the collect lease while it erases the old site's numbers. */
const CHANGE_LEASE_MS = 60_000;

// --- Share access (Connectors 1c) --------------------------------------------------------------

export const ShareBodySchema = z.object({ label: z.string().trim().min(1).max(60).optional() }).strict();

export interface ShareOutcome {
  connection: ConnectionView;
  /** The address to add to the property, the role to give it and where. */
  share: { email: string; role: string; steps: string[] };
  /** True when the brand already had a shared connection waiting for its property: no new address was made. */
  reused: boolean;
}

/** New shared addresses one brand may make for one connector: a few a minute, ten an hour. */
const SHARE_CREATE_LIMIT = { burst: 3, hourly: 10 };

/**
 * The most Google addresses one brand may hold at once for one connector. Every brand shares the
 * identities project's service account quota (100 unless Google raises it), and the rate limit
 * above lets a request through when its store fails, so this cap is what stops one brand filling
 * the project for everyone. The message (share_limit) says the number: change both together.
 */
export const SHARE_ADDRESS_CAP = 5;
/** Disconnected shared connections read when counting addresses a failed delete left at Google. */
const SHARE_LEFTOVER_SCAN = 200;

/** A shared connection's health before Check access first works. */
function notYetChecked(): DataConnection["health"] {
  return { state: "check", lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
}

/**
 * How many Google addresses the brand holds for a connector: its shared connections still
 * connected, and disconnected ones whose address a failed delete left at Google (they still count
 * towards the project's quota until the purge deletes them). Equality only, so no index is needed.
 */
async function liveShareAddresses(ctx: TenantContext, connectorId: string, deps: ServiceDeps): Promise<number> {
  const repo = forTenant(ctx, deps.db).dataConnections;
  const atGoogle = (c: DataConnection) => Boolean(!c.source && c.serviceAccount && !c.serviceAccount.deletedAt);
  const of = (status: DataConnection["status"], limit: number) =>
    repo.find({
      where: [
        ["connectorId", "==", connectorId],
        ["method", "==", "share_access"],
        ["status", "==", status],
      ],
      limit,
    });
  const live = (await of("connected", SHARE_ADDRESS_CAP + 1)).filter(atGoogle).length;
  if (live >= SHARE_ADDRESS_CAP) return live;
  return live + (await of("disconnected", SHARE_LEFTOVER_SCAN)).filter(atGoogle).length;
}

/**
 * Start share access: make the connection's own Google address in the identities project and save
 * the connection with it, reading nothing until an admin adds the address to the property, presses
 * Check access and picks what it reads. A brand with a shared connection still waiting for its
 * property gets that one back instead of a new address, so pressing twice never spends the project's
 * quota. A brand holding SHARE_ADDRESS_CAP addresses for the connector gets no more (share_limit). A
 * full project says so (share_quota), and the screen offers Sign in with Google. Admins only.
 */
export async function shareConnect(ctx: TenantContext, actor: ConnectorActor, connectorId: string, body: unknown, deps: ServiceDeps = {}): Promise<ServiceResult<ShareOutcome>> {
  const m = getConnector(connectorId);
  if (!m) return refuse(404, "not_found");
  if (!can(actor, "connect")) return refuse(403, "forbidden");
  const share = shareMethod(m);
  if (!share) return refuse(400, "method_not_supported");
  const parsed = ShareBodySchema.safeParse(body ?? {});
  if (!parsed.success) return refuse(400, "invalid_input");
  const project = identitiesProject();
  if (!project) return providerRefusal("share_unconfigured");
  const shareOf = (c: DataConnection) => ({ email: c.serviceAccount!.email, role: share.role, steps: share.steps });
  const now = nowOf(deps);

  const waiting = await forTenant(ctx, deps.db).dataConnections.find({
    where: [
      ["connectorId", "==", m.id],
      ["method", "==", "share_access"],
      ["account", "==", ""],
      ["status", "==", "connected"],
    ],
    limit: 5,
  });
  const reuse = waiting.find((c) => !c.source && c.serviceAccount && !c.serviceAccount.deletedAt);
  if (reuse) return { ok: true, status: 200, value: { connection: viewOf(reuse, actor, now), share: shareOf(reuse), reused: true } };
  if ((await liveShareAddresses(ctx, m.id, deps)) >= SHARE_ADDRESS_CAP) return providerRefusal("share_limit");

  const limit = deps.limit ?? ((subject: string, config: Parameters<typeof isRateLimited>[1]) => isRateLimited(subject, config));
  if (await limit(ctx.tenantId, { prefix: `connector-share:${m.id}`, burstLimit: SHARE_CREATE_LIMIT.burst, hourlyLimit: SHARE_CREATE_LIMIT.hourly })) return providerRefusal("busy");

  const id = (deps.newId ?? newDataConnectionId)();
  const made = await createShareAccount(project, ctx.tenantId, id, deps);
  if (!made.ok) return providerRefusal(made.code === "rate_limited" ? "busy" : made.code);
  const at = now.toISOString();
  const serviceAccount: ConnectionServiceAccount = { email: made.account.email, uniqueId: made.account.uniqueId, createdAt: at, deletedAt: null };
  let conn: DataConnection;
  try {
    conn = await createDataConnection(
      ctx,
      {
        id,
        connectorId: m.id,
        method: "share_access",
        label: cleanLabel(parsed.data.label, m.name),
        account: "",
        ownerUid: byOf(actor),
        grants: [],
        secrets: {},
        serviceAccount,
        health: notYetChecked(),
        pausedAt: null,
        pausedBy: null,
        status: "connected",
        createdAt: at,
        updatedAt: at,
        disconnectedAt: null,
      },
      [{ kind: "shared", by: byOf(actor), at }],
      deps.db,
    );
  } catch (err) {
    // Not saved: delete the address at once. One left behind is found by the purge.
    await deleteShareAccount(project, made.account.uniqueId, deps).catch(() => null);
    throw err;
  }
  return { ok: true, status: 201, value: { connection: viewOf(conn, actor, now), share: shareOf(conn), reused: false } };
}

export interface AccessOutcome extends AccountsList {
  connection: ConnectionView;
  /** True when the address sees the property: something to pick, or the one picked. */
  visible: boolean;
  /** Why not, in plain words, or null. */
  message: string | null;
}

/**
 * Check access for a shared connection: mint a token for its address (retrying while Google sets
 * a new one up), list what it can see for the picker and, when one is picked, check that one. The
 * outcome goes on its health and into its activity as access_checked. Admins only.
 */
export async function checkAccess(ctx: TenantContext, actor: ConnectorActor, id: string, deps: ServiceDeps = {}): Promise<ServiceResult<AccessOutcome>> {
  const conn = await load(ctx, id, deps);
  if (!conn || !can(actor, "see", conn.grants)) return refuse(404, "not_found");
  if (!can(actor, "check", conn.grants)) return refuse(403, "forbidden");
  // A part's address and list are its organisation's.
  if (conn.source) return managedByOrganisation();
  if (conn.method !== "share_access") return refuse(400, "method_not_supported");
  const u = await usable(ctx, actor, id, "check", deps);
  if (!u.ok) return u.result;
  const hook = u.manifest.hooks.accounts ? ACCOUNT_HOOKS[u.manifest.hooks.accounts] : undefined;
  const verify = VERIFY_HOOKS[u.manifest.verify.hook];
  if (!hook || !verify) return refuse(503, "connector_unavailable");
  const input = { manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token };
  const listed = forMethod(u.conn, await hook(input, deps));
  if (!listed.ok && listed.code === "busy") return providerRefusal("busy");
  let outcome: { ok: true } | HookFailure = listed.ok ? { ok: true } : listed;
  if (listed.ok && !listed.accounts.length) outcome = { ok: false, code: codeFor(u.conn, "share_not_visible"), retryAfterSec: null };
  else if (listed.ok && u.conn.account) outcome = forMethod(u.conn, await verify(input, deps));
  if (!outcome.ok && outcome.code === "busy") return providerRefusal("busy");

  const now = nowOf(deps);
  const at = now.toISOString();
  const r = await changeDataConnection(
    ctx,
    id,
    (cur) => {
      if (cur.status !== "connected") return null;
      const activity: ActivityWrite[] = [{ kind: "access_checked", by: byOf(actor), at, code: outcome.ok ? "ok" : outcome.code }];
      // Access works again: collecting goes on from the lane's next run.
      if (outcome.ok) return { patch: { health: healthAfterSuccess(cur.health, now), ...(cur.account ? { collect: { ...(cur.collect ?? freshCollect()), nextAt: at } } : {}) }, activity };
      const next = healthAfterFailure(cur.health, outcome.code, now, outcome.retryAfterSec);
      if (next?.pausedNow) activity.push({ kind: "paused", by: "system", at, code: outcome.code });
      return { patch: next ? { health: next.health } : {}, activity };
    },
    deps.db,
  );
  if (!outcome.ok && outcome.code !== "share_not_visible" && outcome.code !== "share_access_lost") return connectionRefusal(u.conn, outcome.code);
  const saved = r.ok ? r.connection : r.why === "unchanged" ? r.connection : u.conn;
  return {
    ok: true,
    status: 200,
    value: {
      connection: viewOf(saved, actor, now),
      accounts: listed.ok ? listed.accounts : [],
      more: listed.ok ? listed.more : false,
      current: u.conn.account,
      visible: outcome.ok,
      message: outcome.ok ? null : connectorMessage(outcome.code, aboutOf(u.conn.connectorId)),
    },
  };
}

/**
 * Delete a shared connection's Google address at Google, after its disconnect or purge is saved.
 * Done (or already gone): deletedAt is set. Failed: a cleanup_failed row, and the address stays on
 * the record for the purge to try again. Its tokens are forgotten either way. True when deleted.
 */
export async function deleteConnectionAddress(ctx: TenantContext, id: string, sa: ConnectionServiceAccount, by: string, deps: ServiceDeps = {}): Promise<boolean> {
  forgetShareTokens(sa.email);
  const project = projectOfShareAccount(sa.email);
  const r = project ? await deleteShareAccount(project, sa.uniqueId, deps) : ({ ok: false, code: "share_unconfigured", retryAfterSec: null } as const);
  const at = nowOf(deps).toISOString();
  if (r.ok) {
    await changeDataConnection(
      ctx,
      id,
      (cur) => (cur.serviceAccount && cur.serviceAccount.uniqueId === sa.uniqueId && !cur.serviceAccount.deletedAt ? { patch: { serviceAccount: { ...cur.serviceAccount, deletedAt: at }, updatedAt: at }, activity: [] } : null),
      deps.db,
    );
    return true;
  }
  await changeDataConnection(ctx, id, () => ({ patch: {}, activity: [{ kind: "cleanup_failed", by, at, code: r.code }] }), deps.db);
  return false;
}

// --- Manage ------------------------------------------------------------------------------------

async function manage(
  ctx: TenantContext,
  actor: ConnectorActor,
  id: string,
  action: "pause" | "resume" | "change_grants" | "disconnect",
  plan: (cur: DataConnection, at: string) => ChangePlan,
  deps: ServiceDeps,
): Promise<ServiceResult<ConnectionView>> {
  const conn = await load(ctx, id, deps);
  if (!conn || !can(actor, "see", conn.grants)) return refuse(404, "not_found");
  if (!can(actor, action, conn.grants)) return refuse(403, "forbidden");
  const now = nowOf(deps);
  const at = now.toISOString();
  const r = await changeDataConnection(ctx, id, (cur) => plan(cur, at), deps.db);
  if (!r.ok && r.why === "not_found") return refuse(404, "not_found");
  return { ok: true, status: 200, value: await viewFor(ctx, r.ok ? r.connection : r.connection, actor, { ...deps, now }) };
}

/** Pause or resume a connection's calls. Resuming also ends a timed pause. Admins only. */
export async function setPaused(ctx: TenantContext, actor: ConnectorActor, id: string, paused: boolean, deps: ServiceDeps = {}): Promise<ServiceResult<ConnectionView>> {
  return manage(
    ctx,
    actor,
    id,
    paused ? "pause" : "resume",
    (cur, at) => {
      if (cur.status !== "connected") return null;
      if (paused) return cur.pausedAt ? null : { patch: { pausedAt: at, pausedBy: byOf(actor) }, activity: [{ kind: "paused", by: byOf(actor), at }] };
      if (!cur.pausedAt && !cur.health.pausedUntil) return null;
      const health = { ...cur.health, pausedUntil: null, failures: 0, state: cur.health.state === "paused" ? ("check" as const) : cur.health.state };
      return { patch: { pausedAt: null, pausedBy: null, health }, activity: [{ kind: "resumed", by: byOf(actor), at }] };
    },
    deps,
  );
}

export const GrantsBodySchema = z.object({ grants: z.array(ConnectionGrantSchema).max(10) }).strict();

/**
 * Set who beyond admins may read a connection live. Admins only. A Search Console connection that
 * stops letting both members and Vizzy read it stops feeding planning at once (pick 6): its open
 * suggestions are declined, the questions it proposed that nobody decided are withdrawn and Next up
 * picks that weighed it are taken off, whatever any switch says; the lane's housekeeping catches a
 * failed try.
 */
export async function setGrants(ctx: TenantContext, actor: ConnectorActor, id: string, body: unknown, deps: ServiceDeps = {}): Promise<ServiceResult<ConnectionView>> {
  const parsed = GrantsBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const grants = normaliseGrants(parsed.data.grants);
  let stopped = false;
  const r = await manage(
    ctx,
    actor,
    id,
    "change_grants",
    (cur, at) => {
      stopped = false;
      if (cur.status !== "connected" || grantsCode(cur.grants) === grantsCode(grants)) return null;
      stopped = cur.connectorId === searchConsoleManifest.id && feedsPlanning(cur.grants) && !feedsPlanning(grants);
      return { patch: { grants }, activity: [{ kind: "grants_changed", by: byOf(actor), at, code: grantsCode(grants) }] };
    },
    deps,
  );
  if (r.ok && stopped) {
    try {
      await stopPlanningFrom(ctx, id, { db: deps.db, now: nowOf(deps) });
    } catch (err) {
      console.warn(`[connectors] withdrawing what ${id} fed planning failed; the lane tries again:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return r;
}

export interface DisconnectOutcome {
  connection: ConnectionView;
  /** Whether access was cancelled at the provider. Never for a pasted token. */
  revoked: boolean;
  /** A shared connection: whether its Google address was deleted. Null for the other methods. */
  addressDeleted: boolean | null;
  /** What to do at the provider, from the manifest, or what revoking or deleting did. */
  message: string;
}

/** What Disconnect says for a shared connection, once its Google address is deleted. */
export const ADDRESS_DELETED_MESSAGE =
  "Disconnected, and its Google address was deleted, so it reads nothing any more. Its entry stays in your property's users until you remove it there; it does no harm.";
/** What Disconnect says when deleting the address failed: the purge tries again. */
export const ADDRESS_KEPT_MESSAGE =
  "Disconnected. YouGrow couldn't delete its Google address just now and tries again later; it reads nothing for this brand any more. You can also remove it from your property's users.";

/** What Disconnect says for a brand's part of its organisation's connection: Stop using. */
export const STOPPED_USING_MESSAGE =
  "This brand stopped using it, so it reads nothing from it any more, and what was collected for it is deleted. Your organisation's owners see that it stopped.";

/** What Disconnect says after Google revoked the sign in: every grant of that account ends. */
export const REVOKED_MESSAGE =
  "Disconnected, and YouGrow's access was removed at Google too. Any other connection signed in with the same Google account has to sign in again.";

/**
 * Disconnect: delete the sealed secrets, mark it disconnected and record it. The record stays, so
 * its activity can still be read. Admins only.
 *
 * A pasted token can't be cancelled from here, so the answer says what to do at the provider. A
 * Google sign in is revoked at Google only with CONNECTOR_GOOGLE_REVOKE_ENABLED on, after the
 * disconnect is saved and best effort, because Google's revoke ends every grant that Google
 * account gave this app, for every brand (decision 2 of the Connectors 1 plan). Off, the answer
 * says how to remove access in the Google account. A shared connection's Google address is deleted
 * at Google after the disconnect is saved; a failed delete is recorded as cleanup_failed and the
 * purge tries again. Its entry in the property's users stays until the admin removes it, harmless.
 */
export async function disconnect(ctx: TenantContext, actor: ConnectorActor, id: string, deps: ServiceDeps = {}): Promise<ServiceResult<DisconnectOutcome>> {
  const part = await load(ctx, id, deps);
  if (part?.source) return stopUsing(ctx, actor, part, deps);
  let signIn: SealedSecret | null = null;
  let address: ConnectionServiceAccount | null = null;
  let changed = false;
  const r = await manage(
    ctx,
    actor,
    id,
    "disconnect",
    (cur, at) => {
      signIn = null;
      address = null;
      changed = false;
      if (cur.status === "disconnected") return null;
      changed = true;
      signIn = cur.method === "oauth_pkce" ? (cur.secrets[REFRESH_SLOT] ?? null) : null;
      address = cur.method === "share_access" && cur.serviceAccount && !cur.serviceAccount.deletedAt ? cur.serviceAccount : null;
      // What it collected is marked for erasing in the same change, so a failed erase is retried.
      const collect = { ...(cur.collect ?? freshCollect()), erasePending: "all" as const, nextAt: null, leaseId: null, leaseUntil: null };
      return { patch: { secrets: {}, status: "disconnected", disconnectedAt: at, pausedAt: null, pausedBy: null, collect }, activity: [{ kind: "disconnected", by: byOf(actor), at }] };
    },
    deps,
  );
  if (!r.ok) return r;
  if (changed) {
    // Whatever any collect switch says: Disconnect deletes what YouGrow stored for it.
    try {
      await eraseConnectionData(ctx, id, "all", { by: byOf(actor), now: nowOf(deps), db: deps.db, searchIndex: deps.searchIndex });
    } catch (err) {
      console.warn(`[connectors] erase after Disconnect failed for ${id}; the lane tries again:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  let revoked = false;
  const sealed = signIn as SealedSecret | null;
  if (sealed && isGoogleRevokeEnabled()) {
    try {
      revoked = await revokeGoogleToken(openConnectorSecret(ctx.tenantId, id, REFRESH_SLOT, sealed), deps);
    } catch (err) {
      if (!(err instanceof VaultOpenError)) throw err;
    }
  }
  const sa = address as ConnectionServiceAccount | null;
  if (sa) {
    const deleted = await deleteConnectionAddress(ctx, id, sa, byOf(actor), deps);
    const after = await load(ctx, id, deps);
    const connection = after ? viewOf(after, actor, nowOf(deps)) : r.value;
    return { ok: true, status: 200, value: { connection, revoked: false, addressDeleted: deleted, message: deleted ? ADDRESS_DELETED_MESSAGE : ADDRESS_KEPT_MESSAGE } };
  }
  const m = knownConnector(r.value.connectorId);
  return { ok: true, status: 200, value: { connection: r.value, revoked, addressDeleted: null, message: revoked ? REVOKED_MESSAGE : (m?.disconnect ?? "Disconnected.") } };
}

/**
 * Stop using a brand's part of its organisation's connection (Connectors 3): Disconnect on a part,
 * for the brand's admins. In three steps (src/lib/tenant/organisationConnections.ts endPart): the
 * part goes `ending` on the organisation's record, the brand record goes disconnected with
 * everything it collected marked for erasing and any secret emptied, then the entry leaves the
 * organisation's record. If the sign in's database can't be written, the brand record is ended
 * anyway and housekeeping removes the entry. Then what it collected is erased. It never revokes a
 * sign in and never deletes the organisation's Google address: other brands still use them.
 */
async function stopUsing(ctx: TenantContext, actor: ConnectorActor, conn: DataConnection, deps: ServiceDeps): Promise<ServiceResult<DisconnectOutcome>> {
  if (!can(actor, "see", conn.grants)) return refuse(404, "not_found");
  if (!can(actor, "disconnect", conn.grants)) return refuse(403, "forbidden");
  const now = nowOf(deps);
  const source = conn.source!;
  const ended = await endPart(
    { source, brand: { tenantId: ctx.tenantId, region: ctx.region }, useId: conn.id, by: byOf(actor), at: now.toISOString(), code: "stopped_using", evenIfSourceFails: true },
    storesOf(deps),
  );
  if (ended.ended) {
    // Whatever any collect switch says: Stop using deletes what YouGrow stored for it.
    try {
      await eraseConnectionData(ctx, conn.id, "all", { by: byOf(actor), now, db: deps.db, searchIndex: deps.searchIndex });
    } catch (err) {
      console.warn(`[connectors] erase after Stop using failed for ${conn.id}; the lane tries again:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  const after = (await load(ctx, conn.id, deps)) ?? conn;
  // Its view says it ended (and who gave it), so its activity keeps its organisation's name.
  const view = after.status === "connected" ? viewOf(after, actor, now, { partLive: false }) : await viewFor(ctx, after, actor, { ...deps, now });
  return { ok: true, status: 200, value: { connection: view, revoked: false, addressDeleted: null, message: STOPPED_USING_MESSAGE } };
}
