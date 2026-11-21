import { randomBytes } from "node:crypto";
import { z } from "zod";
import { changeDataConnection, createDataConnection, forTenant, type ActivityWrite, type ChangePlan, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { meaningsOf } from "@/lib/metrics/meanings";
import { ConnectionGrantSchema, type ConnectionGrant, type DataConnection } from "@/lib/types/dataConnection";
import { can, grantsCode, normaliseGrants, type ConnectorActor } from "./grants";
import { healthAfterFailure, healthAfterSuccess, healthyAt, isCallPaused, shownState } from "./health";
import { ACCOUNT_HOOKS, VERIFY_HOOKS } from "./handlers";
import type { ConnectorAccount, HookFailure } from "./handlers/types";
import { checkLiveRequest, lagWords, readLive, type LiveAnswer } from "./live";
import { tokenMethod, type ConnectMethodName, type ConnectorManifest } from "./manifest";
import { connectorMessage, type ConnectorErrorCode } from "./messages";
import { getConnector, knownConnector, listConnectors, readyMethods } from "./registry";
import type { ConnectorFetchDeps } from "./safeFetch";
import { isGoogleRevokeEnabled } from "./flags";
import { revokeGoogleToken } from "./google";
import { freshAccessToken, REFRESH_SLOT, type KeeperDeps } from "./tokenKeeper";
import { isVaultConfigured, openConnectorSecret, sealConnectorSecret, VaultOpenError, type SealedSecret } from "./vault";

/**
 * What the connector routes do (ADR-0011), each returning a result the route turns into a
 * response. Every function takes the server's TenantContext and the acting person, checks the
 * grants table first, reaches data only through forTenant and the connected data writer, and
 * calls providers only through safe fetch. Secrets are opened only for the call that needs them
 * and never leave here.
 */

export interface ServiceDeps extends ConnectorFetchDeps, KeeperDeps {
  db?: FirestoreLike;
  newId?: () => string;
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

const CONFLICTS: ReadonlySet<ConnectorErrorCode> = new Set(["paused", "secret_unopenable", "disconnected", "signin_refused", "account_needed"]);

/**
 * A provider or vault failure: busy is 429; a pause, a dead token or sign in, or no site picked
 * yet 409; this copy missing a key or a Google client 503; the rest 502.
 */
export function providerRefusal(code: ConnectorErrorCode): ServiceResult<never> {
  const status = code === "busy" ? 429 : CONFLICTS.has(code) ? 409 : code === "vault_unconfigured" || code === "signin_unconfigured" ? 503 : 502;
  return refuse(status, code, connectorMessage(code));
}

const nowOf = (deps: ServiceDeps) => deps.now ?? new Date();
export const byOf = (actor: ConnectorActor) => (actor.kind === "agent" ? `agent:${actor.agent}` : actor.uid || "system");

// --- What people see ---------------------------------------------------------------------------

export interface ConnectorListing {
  id: string;
  name: string;
  summary: string;
  category: string;
  connect: ConnectorManifest["connect"];
  /** The sign-in methods this copy can use now (Sign in with Google needs its client). */
  ready: ConnectMethodName[];
  shares: ConnectorManifest["shares"];
  produces: Array<{ stream: string; description: string; shape: string; measures: Array<{ key: string; name: string; definition: string; caveat?: string }>; lag: string; liveBy: string[] }>;
  uses: ConnectorManifest["uses"];
  disconnect: string;
}

/** A manifest as Browse and Listing show it: everything public, nothing about a connection. */
export function listingOf(m: ConnectorManifest): ConnectorListing {
  return {
    id: m.id,
    name: m.name,
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
    })),
    uses: m.uses,
    disconnect: m.disconnect,
  };
}

export interface ConnectionView {
  id: string;
  connectorId: string;
  connectorName: string;
  /** False when this copy has the connector switched off: the connection stays, unread. */
  connectorOn: boolean;
  label: string;
  status: DataConnection["status"];
  health: { state: ReturnType<typeof shownState>; lastOkAt: string | null; lastCheckedAt: string | null; message: string | null; pausedUntil: string | null };
  /** True after a sign in until an admin picks the site or property it reads. */
  needsAccount: boolean;
  canReadLive: boolean;
  /** Admins only. */
  details?: {
    method: DataConnection["method"];
    account: string;
    ownerUid: string;
    grants: ConnectionGrant[];
    recent: DataConnection["recent"];
    /** Which secrets are kept and when they were sealed, never the secrets. */
    secrets: Array<{ slot: string; sealedAt: string }>;
    pausedAt: string | null;
    pausedBy: string | null;
    createdAt: string;
    updatedAt: string;
    disconnectedAt: string | null;
  };
}

/** A connection as this actor may see it: name and health for anyone allowed to see it, the rest for admins. */
export function viewOf(conn: DataConnection, actor: ConnectorActor, now: Date): ConnectionView {
  const known = knownConnector(conn.connectorId);
  const view: ConnectionView = {
    id: conn.id,
    connectorId: conn.connectorId,
    connectorName: known?.name ?? conn.connectorId,
    connectorOn: getConnector(conn.connectorId) !== null,
    label: conn.label,
    status: conn.status,
    health: {
      state: shownState(conn, now),
      lastOkAt: conn.health.lastOkAt,
      lastCheckedAt: conn.health.lastCheckedAt,
      message: conn.health.lastErrorCode ? connectorMessage(conn.health.lastErrorCode) : null,
      pausedUntil: conn.health.pausedUntil,
    },
    needsAccount: conn.status === "connected" && !conn.account,
    canReadLive: conn.status === "connected" && !!conn.account && can(actor, "read_live", conn.grants),
  };
  if (can(actor, "see_details", conn.grants)) {
    view.details = {
      method: conn.method,
      account: conn.account,
      ownerUid: conn.ownerUid,
      grants: conn.grants,
      recent: conn.recent,
      secrets: Object.entries(conn.secrets).map(([slot, s]) => ({ slot, sealedAt: s.sealedAt })),
      pausedAt: conn.pausedAt,
      pausedBy: conn.pausedBy,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
      disconnectedAt: conn.disconnectedAt,
    };
  }
  return view;
}

/** Browse and the brand's connections, newest first, as this actor may see them. */
export async function listForActor(ctx: TenantContext, actor: ConnectorActor, deps: ServiceDeps = {}): Promise<ServiceResult<{ connectors: ConnectorListing[]; connections: ConnectionView[] }>> {
  const now = nowOf(deps);
  const rows = await forTenant(ctx, deps.db).dataConnections.find({ limit: LIST_LIMIT });
  const connections = rows
    .filter((c) => can(actor, "see", c.grants))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => viewOf(c, actor, now));
  return { ok: true, status: 200, value: { connectors: listConnectors().map(listingOf), connections } };
}

async function load(ctx: TenantContext, id: string, deps: ServiceDeps): Promise<DataConnection | null> {
  return forTenant(ctx, deps.db).dataConnections.getById(id);
}

/** One connection, or 404 for an id this brand doesn't have or this actor may not see. */
export async function getForActor(ctx: TenantContext, actor: ConnectorActor, id: string, deps: ServiceDeps = {}): Promise<ServiceResult<ConnectionView>> {
  const conn = await load(ctx, id, deps);
  if (!conn || !can(actor, "see", conn.grants)) return refuse(404, "not_found");
  return { ok: true, status: 200, value: viewOf(conn, actor, nowOf(deps)) };
}

// --- Connect -----------------------------------------------------------------------------------

export const ConnectBodySchema = z
  .object({
    fields: z.record(z.string().max(64), z.string().max(4096)).refine((f) => Object.keys(f).length <= 10, "too many fields"),
    label: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

/**
 * The typed fields, checked against the manifest. A refusal names the manifest's own labels for
 * the fields that failed, never a value, and never echoes a key the manifest doesn't have.
 */
export function checkFields(m: ConnectorManifest, raw: Record<string, string>): { ok: true; values: Record<string, string> } | { ok: false; labels: string[] } {
  const method = tokenMethod(m);
  if (!method) return { ok: false, labels: [] };
  const labels: string[] = [];
  const values: Record<string, string> = {};
  for (const f of method.fields) {
    const v = (raw[f.key] ?? "").trim();
    if (v.length < f.minLength || v.length > f.maxLength || !new RegExp(f.pattern).test(v)) labels.push(f.label);
    else values[f.key] = v;
  }
  if (Object.keys(raw).some((k) => !method.fields.some((f) => f.key === k))) labels.push("the fields sent: one isn't asked for here");
  return labels.length ? { ok: false, labels } : { ok: true, values };
}

function cleanLabel(label: string | undefined, fallback: string): string {
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
  if (!result.ok) return providerRefusal(result.code);

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
    },
    [{ kind: "connected", by: byOf(actor), at }],
    deps.db,
  );
  return { ok: true, status: 201, value: viewOf(conn, actor, now) };
}

// --- Calls that use the stored secret ---------------------------------------------------------

/** The activity and health patch for a call's outcome. */
function outcomePlan(cur: DataConnection, outcome: { ok: true } | HookFailure, actor: ConnectorActor, now: Date, onSuccess: ActivityWrite["kind"] | null): ChangePlan {
  const at = now.toISOString();
  if (outcome.ok) {
    const recentOk = cur.health.state === "ok" && cur.health.lastOkAt && now.getTime() - Date.parse(cur.health.lastOkAt) < 10 * 60_000;
    if (!onSuccess && recentOk) return null;
    return { patch: { health: healthAfterSuccess(cur.health, now) }, activity: onSuccess ? [{ kind: onSuccess, by: byOf(actor), at }] : [] };
  }
  const next = healthAfterFailure(cur.health, outcome.code, now, outcome.retryAfterSec);
  if (!next) return null;
  const activity: ActivityWrite[] = [{ kind: "failed", by: byOf(actor), at, code: outcome.code }];
  if (next.pausedNow) activity.push({ kind: "paused", by: "system", at, code: outcome.code });
  return { patch: { health: next.health }, activity };
}

type Usable = { ok: true; conn: DataConnection; manifest: ConnectorManifest; token: string } | { ok: false; result: ServiceResult<never> };

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
  if (conn.method === "oauth_pkce") {
    // A Google sign in: the token keeper refreshes the access token under its lease when it is due.
    const kept = await freshAccessToken(ctx, conn, byOf(actor), deps);
    if (kept.ok) return { ok: true, conn, manifest, token: kept.token };
    if (!kept.recorded) {
      await changeDataConnection(ctx, conn.id, (cur) => outcomePlan(cur, { ok: false, code: kept.code, retryAfterSec: kept.retryAfterSec }, actor, now, null), deps.db);
    }
    return { ok: false, result: providerRefusal(kept.code) };
  }
  const method = tokenMethod(manifest);
  const sealed = method ? conn.secrets[method.auth.field] : undefined;
  let token: string;
  try {
    if (!sealed) throw new VaultOpenError("unopenable");
    token = openConnectorSecret(ctx.tenantId, conn.id, method!.auth.field, sealed);
  } catch (err) {
    if (!(err instanceof VaultOpenError)) throw err;
    await changeDataConnection(ctx, conn.id, (cur) => outcomePlan(cur, { ok: false, code: "secret_unopenable", retryAfterSec: null }, actor, now, null), deps.db);
    return { ok: false, result: providerRefusal("secret_unopenable") };
  }
  return { ok: true, conn, manifest, token };
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
  const outcome = await verify({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token }, deps);
  if (!outcome.ok && outcome.code === "busy") return providerRefusal("busy");
  const r = await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, outcome, actor, now, "verified"), deps.db);
  const conn = r.ok ? r.connection : r.why === "unchanged" ? r.connection : u.conn;
  return {
    ok: true,
    status: 200,
    value: {
      connection: viewOf(conn, actor, now),
      check: outcome.ok ? { ok: true, code: null, message: null } : { ok: false, code: outcome.code, message: connectorMessage(outcome.code) },
    },
  };
}

/** A live read, for an admin or a member with the read grant. Records failures on health. */
export async function readLiveFor(ctx: TenantContext, actor: ConnectorActor, id: string, rawQuery: unknown, deps: ServiceDeps = {}): Promise<ServiceResult<LiveAnswer>> {
  const u = await usable(ctx, actor, id, "read_live", deps);
  if (!u.ok) return u.result;
  const now = nowOf(deps);
  const checked = checkLiveRequest(u.manifest, rawQuery, now);
  if (!checked.ok) return refuse(400, checked.error);
  const r = await readLive({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token, query: checked.query }, deps);
  if (!r.ok && r.code === "busy") return providerRefusal("busy");
  await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, r.ok ? { ok: true } : r, actor, now, null), deps.db);
  if (!r.ok) return providerRefusal(r.code);
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
  const u = await usable(ctx, actor, id, "check", deps);
  if (!u.ok) return u.result;
  const hook = u.manifest.hooks.accounts ? ACCOUNT_HOOKS[u.manifest.hooks.accounts] : undefined;
  if (!hook) return refuse(400, "method_not_supported");
  const now = nowOf(deps);
  const r = await hook({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token }, deps);
  if (!r.ok) {
    if (r.code !== "busy") await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, r, actor, now, null), deps.db);
    return providerRefusal(r.code);
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
  if (conn.method === "token_fields") return refuse(400, "method_not_supported");
  const u = await usable(ctx, actor, id, "check", deps);
  if (!u.ok) return u.result;
  const account = parsed.data.account;
  const verify = VERIFY_HOOKS[u.manifest.verify.hook];
  if (!verify) return refuse(503, "connector_unavailable");
  const checked = await verify({ manifest: u.manifest, connection: u.conn, account, token: u.token }, deps);
  if (!checked.ok) {
    if (checked.code === "account_refused") return refuse(400, "account_refused", "That site isn't one this sign in can read. Pick one from the list.");
    return providerRefusal(checked.code);
  }
  const existing = await forTenant(ctx, deps.db).dataConnections.find({
    where: [
      ["connectorId", "==", u.conn.connectorId],
      ["account", "==", account],
      ["status", "==", "connected"],
    ],
    limit: 2,
  });
  if (existing.some((c) => c.id !== id)) return refuse(409, "already_connected", "Another connection reads this already. Check or disconnect it there.");
  const now = nowOf(deps);
  const at = now.toISOString();
  const r = await changeDataConnection(
    ctx,
    id,
    (cur) => {
      if (cur.status !== "connected" || cur.account === account) return null;
      return { patch: { account, health: healthAfterSuccess(cur.health, now) }, activity: [{ kind: "account_picked", by: byOf(actor), at }] };
    },
    deps.db,
  );
  if (!r.ok && r.why === "not_found") return refuse(404, "not_found");
  return { ok: true, status: 200, value: viewOf(r.ok ? r.connection : r.connection, actor, now) };
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
  return { ok: true, status: 200, value: viewOf(r.ok ? r.connection : r.connection, actor, now) };
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

/** Set who beyond admins may read a connection live. Admins only. */
export async function setGrants(ctx: TenantContext, actor: ConnectorActor, id: string, body: unknown, deps: ServiceDeps = {}): Promise<ServiceResult<ConnectionView>> {
  const parsed = GrantsBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, "invalid_input");
  const grants = normaliseGrants(parsed.data.grants);
  return manage(
    ctx,
    actor,
    id,
    "change_grants",
    (cur, at) => {
      if (cur.status !== "connected" || grantsCode(cur.grants) === grantsCode(grants)) return null;
      return { patch: { grants }, activity: [{ kind: "grants_changed", by: byOf(actor), at, code: grantsCode(grants) }] };
    },
    deps,
  );
}

export interface DisconnectOutcome {
  connection: ConnectionView;
  /** Whether access was cancelled at the provider. Never for a pasted token. */
  revoked: boolean;
  /** What to do at the provider, from the manifest, or what revoking did. */
  message: string;
}

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
 * says how to remove access in the Google account.
 */
export async function disconnect(ctx: TenantContext, actor: ConnectorActor, id: string, deps: ServiceDeps = {}): Promise<ServiceResult<DisconnectOutcome>> {
  let signIn: SealedSecret | null = null;
  const r = await manage(
    ctx,
    actor,
    id,
    "disconnect",
    (cur, at) => {
      signIn = null;
      if (cur.status === "disconnected") return null;
      signIn = cur.method === "oauth_pkce" ? (cur.secrets[REFRESH_SLOT] ?? null) : null;
      return { patch: { secrets: {}, status: "disconnected", disconnectedAt: at, pausedAt: null, pausedBy: null }, activity: [{ kind: "disconnected", by: byOf(actor), at }] };
    },
    deps,
  );
  if (!r.ok) return r;
  let revoked = false;
  const sealed = signIn as SealedSecret | null;
  if (sealed && isGoogleRevokeEnabled()) {
    try {
      revoked = await revokeGoogleToken(openConnectorSecret(ctx.tenantId, id, REFRESH_SLOT, sealed), deps);
    } catch (err) {
      if (!(err instanceof VaultOpenError)) throw err;
    }
  }
  const m = knownConnector(r.value.connectorId);
  return { ok: true, status: 200, value: { connection: r.value, revoked, message: revoked ? REVOKED_MESSAGE : (m?.disconnect ?? "Disconnected.") } };
}
