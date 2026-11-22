import { randomBytes } from "node:crypto";
import { z } from "zod";
import { changeDataConnection, createDataConnection, forTenant, isRateLimited, type ActivityWrite, type ChangePlan, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { meaningsOf } from "@/lib/metrics/meanings";
import { ConnectionGrantSchema, type ActivityKind, type ConnectionGrant, type ConnectionServiceAccount, type DataConnection } from "@/lib/types/dataConnection";
import { can, grantsCode, normaliseGrants, type ConnectorActor } from "./grants";
import { healthAfterFailure, healthAfterSuccess, healthyAt, isCallPaused, shownState } from "./health";
import { ACCOUNT_HOOKS, VERIFY_HOOKS } from "./handlers";
import type { ConnectorAccount, HookFailure } from "./handlers/types";
import { checkLiveRequest, lagWords, readLive, type LiveAnswer } from "./live";
import { shareMethod, tokenMethod, type ConnectMethodName, type ConnectorManifest } from "./manifest";
import { connectorMessage, tokenRefusedMessage, type ConnectorErrorCode } from "./messages";
import { getConnector, knownConnector, listConnectors, readyMethods } from "./registry";
import type { ConnectorFetchDeps } from "./safeFetch";
import { isConnectorsChatEnabled, isGoogleRevokeEnabled } from "./flags";
import { revokeGoogleToken } from "./google";
import { createShareAccount, deleteShareAccount, forgetShareTokens, identitiesProject, projectOfShareAccount, shareAccessToken, type ShareDeps, type ShareResult } from "./shareAccess";
import { freshAccessToken, REFRESH_SLOT, type KeeperDeps } from "./tokenKeeper";
import { isVaultConfigured, openConnectorSecret, sealConnectorSecret, VaultOpenError, type SealedSecret } from "./vault";

/**
 * What the connector routes do (ADR-0011), each returning a result the route turns into a
 * response. Every function takes the server's TenantContext and the acting person, checks the
 * grants table first, reaches data only through forTenant and the connected data writer, and
 * calls providers only through safe fetch. Secrets are opened only for the call that needs them
 * and never leave here.
 */

export interface ServiceDeps extends ConnectorFetchDeps, KeeperDeps, ShareDeps {
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

const CONFLICTS: ReadonlySet<ConnectorErrorCode> = new Set(["paused", "secret_unopenable", "disconnected", "signin_refused", "account_needed", "share_not_visible", "share_pending", "share_limit"]);
const UNCONFIGURED: ReadonlySet<ConnectorErrorCode> = new Set(["vault_unconfigured", "signin_unconfigured", "share_unconfigured", "share_quota"]);

/**
 * A provider or vault failure: busy is 429; a pause, a dead token or sign in, no site picked yet,
 * a shared address that can't see the property yet, or a brand holding all the shared addresses
 * it may 409; this copy missing a key, a Google
 * client or its identities project, or that project being full, 503; the rest 502.
 */
export function providerRefusal(code: ConnectorErrorCode): ServiceResult<never> {
  const status = code === "busy" ? 429 : CONFLICTS.has(code) ? 409 : UNCONFIGURED.has(code) ? 503 : 502;
  return refuse(status, code, connectorMessage(code));
}

/** A refusal while connecting, before anything is saved: a turned down token names its tool. */
function connectingRefusal(m: ConnectorManifest, code: ConnectorErrorCode): ServiceResult<never> {
  const r = providerRefusal(code);
  return code === "token_refused" && !r.ok ? { ...r, message: tokenRefusedMessage(m.name, "connecting", isConnectorsChatEnabled()) } : r;
}

/** A connection's tool and whether Vizzy reads connected data, so its messages can name the tool. */
const aboutOf = (connectorId: string) => ({ name: knownConnector(connectorId)?.name ?? connectorId, chat: isConnectorsChatEnabled() });

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

export function codeFor(method: DataConnection["method"], code: ConnectorErrorCode): ConnectorErrorCode {
  return method === "share_access" ? (SHARE_CODES[code] ?? code) : code;
}

function forMethod<T extends { ok: boolean }>(method: DataConnection["method"], r: T): T {
  if (r.ok || method !== "share_access") return r;
  const failed = r as T & { code: ConnectorErrorCode };
  return { ...failed, code: codeFor(method, failed.code) };
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
    /** A shared connection's Google address, to add to the property; null for the other methods. */
    serviceAccount: { email: string; deletedAt: string | null } | null;
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
      message: conn.health.lastErrorCode ? connectorMessage(conn.health.lastErrorCode, aboutOf(conn.connectorId)) : null,
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
      serviceAccount: conn.serviceAccount ? { email: conn.serviceAccount.email, deletedAt: conn.serviceAccount.deletedAt } : null,
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

/** The activity and health patch for a call's outcome. */
function outcomePlan(cur: DataConnection, outcome: { ok: true } | HookFailure, actor: ConnectorActor, now: Date, onSuccess: ActivityWrite["kind"] | null): ChangePlan {
  const at = now.toISOString();
  if (outcome.ok) {
    const recentOk = cur.health.state === "ok" && cur.health.lastOkAt && now.getTime() - Date.parse(cur.health.lastOkAt) < 10 * 60_000;
    if (!onSuccess && recentOk) return null;
    // Vizzy's reads are logged but kept off the recent list (the Connected view shows people's changes).
    return { patch: { health: healthAfterSuccess(cur.health, now) }, activity: onSuccess ? [{ kind: onSuccess, by: byOf(actor), at, ...(onSuccess === "read" ? { recent: false } : {}) }] : [] };
  }
  const next = healthAfterFailure(cur.health, outcome.code, now, outcome.retryAfterSec);
  if (!next) return null;
  const activity: ActivityWrite[] = [{ kind: "failed", by: byOf(actor), at, code: outcome.code }];
  if (next.pausedNow) activity.push({ kind: "paused", by: "system", at, code: outcome.code });
  return { patch: { health: next.health }, activity };
}

type Usable = { ok: true; conn: DataConnection; manifest: ConnectorManifest; token: string } | { ok: false; result: ServiceResult<never> };

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
  if (conn.method === "share_access") {
    // A shared address: a 300 second token minted for it, kept only in this server's memory.
    const kept = await shareToken(conn, manifest, deps);
    if (kept.ok) return { ok: true, conn, manifest, token: kept.token };
    await changeDataConnection(ctx, conn.id, (cur) => outcomePlan(cur, { ok: false, code: kept.code, retryAfterSec: kept.retryAfterSec }, actor, now, null), deps.db);
    return { ok: false, result: providerRefusal(kept.code) };
  }
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
  const outcome = forMethod(u.conn.method, await verify({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token }, deps));
  if (!outcome.ok && outcome.code === "busy") return providerRefusal("busy");
  const r = await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, outcome, actor, now, "verified"), deps.db);
  const conn = r.ok ? r.connection : r.why === "unchanged" ? r.connection : u.conn;
  return {
    ok: true,
    status: 200,
    value: {
      connection: viewOf(conn, actor, now),
      check: outcome.ok ? { ok: true, code: null, message: null } : { ok: false, code: outcome.code, message: connectorMessage(outcome.code, aboutOf(u.conn.connectorId)) },
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
  const r = forMethod(u.conn.method, await readLive({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token, query: checked.query }, deps));
  if (!r.ok && r.code === "busy") return providerRefusal("busy");
  await changeDataConnection(ctx, id, (cur) => outcomePlan(cur, r.ok ? { ok: true } : r, actor, now, record), deps.db);
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
  // A token connection picks its account before it is saved (checkToken) and never changes it here.
  if (!hook || u.conn.method === "token_fields") return refuse(400, "method_not_supported");
  const now = nowOf(deps);
  const r = forMethod(u.conn.method, await hook({ manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token }, deps));
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
    if (checked.code === "account_refused") return refuse(400, "account_refused", "That site or property isn't one this connection can read. Pick one from the list.");
    return providerRefusal(codeFor(u.conn.method, checked.code));
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
  const atGoogle = (c: DataConnection) => Boolean(c.serviceAccount && !c.serviceAccount.deletedAt);
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
  const reuse = waiting.find((c) => c.serviceAccount && !c.serviceAccount.deletedAt);
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
  if (conn.method !== "share_access") return refuse(400, "method_not_supported");
  const u = await usable(ctx, actor, id, "check", deps);
  if (!u.ok) return u.result;
  const hook = u.manifest.hooks.accounts ? ACCOUNT_HOOKS[u.manifest.hooks.accounts] : undefined;
  const verify = VERIFY_HOOKS[u.manifest.verify.hook];
  if (!hook || !verify) return refuse(503, "connector_unavailable");
  const input = { manifest: u.manifest, connection: u.conn, account: u.conn.account, token: u.token };
  const listed = forMethod(u.conn.method, await hook(input, deps));
  if (!listed.ok && listed.code === "busy") return providerRefusal("busy");
  let outcome: { ok: true } | HookFailure = listed.ok ? { ok: true } : listed;
  if (listed.ok && !listed.accounts.length) outcome = { ok: false, code: "share_not_visible", retryAfterSec: null };
  else if (listed.ok && u.conn.account) outcome = forMethod(u.conn.method, await verify(input, deps));
  if (!outcome.ok && outcome.code === "busy") return providerRefusal("busy");

  const now = nowOf(deps);
  const at = now.toISOString();
  const r = await changeDataConnection(
    ctx,
    id,
    (cur) => {
      if (cur.status !== "connected") return null;
      const activity: ActivityWrite[] = [{ kind: "access_checked", by: byOf(actor), at, code: outcome.ok ? "ok" : outcome.code }];
      if (outcome.ok) return { patch: { health: healthAfterSuccess(cur.health, now) }, activity };
      const next = healthAfterFailure(cur.health, outcome.code, now, outcome.retryAfterSec);
      if (next?.pausedNow) activity.push({ kind: "paused", by: "system", at, code: outcome.code });
      return { patch: next ? { health: next.health } : {}, activity };
    },
    deps.db,
  );
  if (!outcome.ok && outcome.code !== "share_not_visible") return providerRefusal(outcome.code);
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
  let signIn: SealedSecret | null = null;
  let address: ConnectionServiceAccount | null = null;
  const r = await manage(
    ctx,
    actor,
    id,
    "disconnect",
    (cur, at) => {
      signIn = null;
      address = null;
      if (cur.status === "disconnected") return null;
      signIn = cur.method === "oauth_pkce" ? (cur.secrets[REFRESH_SLOT] ?? null) : null;
      address = cur.method === "share_access" && cur.serviceAccount && !cur.serviceAccount.deletedAt ? cur.serviceAccount : null;
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
