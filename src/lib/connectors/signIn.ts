import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { changeDataConnection, consumeConnectionState, createConnectionState, createDataConnection, forTenant, STATE_VALID_MS, type TenantContext } from "@/lib/tenant";
import { originFromHeaders } from "@/lib/http/origin";
import { generatePkce } from "@/lib/social/x/oauth";
import { DATA_CONNECTION_ID_RE, type DataConnection } from "@/lib/types/dataConnection";
import { can, type ConnectorActor } from "./grants";
import { checkedConnectorsOrigin, exchangeGoogleCode, googleAuthorizeUrl, googleClient, pinnedConnectorsOrigin } from "./google";
import { VERIFY_HOOKS } from "./handlers";
import { healthyAt } from "./health";
import { oauthMethod, type ConnectorManifest } from "./manifest";
import { connectorMessage, type SignInReason } from "./messages";
import { getConnector, knownConnector, methodSwitchOn } from "./registry";
import { newDataConnectionId, type ServiceDeps, type ServiceResult } from "./service";
import { ACCESS_SLOT, REFRESH_SLOT } from "./tokenKeeper";
import { isVaultConfigured, sealConnectorSecret, signConnectorState, verifyConnectorState } from "./vault";

/**
 * Sign in with Google for connected data (Connectors 1b, ADR-0011). Four things bind a sign in,
 * and the callback checks every one before a code is swapped for tokens:
 *
 * 1. A state signed with the vault's state key, naming the brand, the connector, the admin and
 *    a nonce, valid for 10 minutes. Another brand's state, or one started by another admin, is
 *    refused.
 * 2. The browser: an httpOnly cookie holding the nonce and the PKCE verifier, one per attempt (its
 *    name comes from the nonce, so two sign ins in two tabs never clash), path scoped to the
 *    callback, SameSite=Lax because Strict would drop it on Google's redirect back. A state
 *    finished in another browser has no cookie to match.
 * 3. A single use server record in data_connection_states (id: the nonce's SHA-256), claimed in a
 *    transaction and deleted, so a replayed callback is refused. The X and LinkedIn flows lack it.
 * 4. PKCE S256: the verifier never leaves the browser's cookie and the server.
 *
 * Google's redirect arrives cross-site, so the callback has no origin check (integrationsHopAdmin
 * in its route); the start is a same-origin POST through integrationsAdmin. The redirect address
 * is CONNECTORS_OAUTH_ORIGIN; a production server without it refuses to start (fail closed), and
 * a local run uses the request's own origin. After the swap the scope granted must be exactly the
 * one asked for, Google must have sent a refresh token, and the connector's verify request must
 * pass before anything is saved. A new connection has no site picked; signing in again for a
 * connection keeps its site, grants and history. A brand's part of its organisation's connection
 * (Connectors 3) is never signed in again here, at the start or at the callback.
 */

export const CALLBACK_PATH = "/api/admin/connectors/callback";
export const STATE_COOKIE_PREFIX = "yg_dcs_";
const COOKIE_MAX_AGE_SEC = STATE_VALID_MS / 1000;
/** A state signed this far in the future is refused too (clock skew allowed). */
const FUTURE_SKEW_MS = 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

export type SignInDeps = ServiceDeps;

/** The origin Google returns people to: pinned, else (outside production) the request's own. */
export function connectorsOrigin(headers: Headers): string | null {
  const pinned = pinnedConnectorsOrigin();
  if (pinned) return checkedConnectorsOrigin(pinned);
  if (process.env.NODE_ENV === "production") return null;
  return checkedConnectorsOrigin(originFromHeaders(headers));
}

/** The server record's id for a nonce. */
export function stateIdOf(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

/** The cookie that carries one attempt's nonce and verifier. */
export function stateCookieName(nonce: string): string {
  return `${STATE_COOKIE_PREFIX}${stateIdOf(nonce).slice(0, 24)}`;
}

/** Where the callback sends people: the connector's Listing page, or Connections. */
export function signInReturnPath(connectorId: string | null, params: Record<string, string>): string {
  const base = connectorId && knownConnector(connectorId) ? `/admin/account/connections/${connectorId}` : "/admin/account/connections";
  return `${base}?${new URLSearchParams(params).toString()}`;
}

// --- Start -------------------------------------------------------------------------------------

export const StartBodySchema = z.object({ connectionId: z.string().regex(DATA_CONNECTION_ID_RE).optional() }).strict();

export interface StateCookie {
  name: string;
  value: string;
  path: typeof CALLBACK_PATH;
  maxAge: number;
  secure: boolean;
  httpOnly: true;
  sameSite: "lax";
}

export interface StartedSignIn {
  /** Google's authorize address, for the browser to go to. */
  url: string;
  cookie: StateCookie;
}

const refused = (status: 400 | 403 | 404 | 409 | 503, error: string, message?: string): ServiceResult<never> => ({ ok: false, status, error, ...(message ? { message } : {}) });

/**
 * Start a sign in with Google for a connector, or for one of its connections to sign in again.
 * Admins only. Makes the server record and returns Google's address and the cookie to set.
 */
export async function startSignIn(
  ctx: TenantContext,
  actor: ConnectorActor,
  connectorId: string,
  body: unknown,
  headers: Headers,
  deps: SignInDeps = {},
): Promise<ServiceResult<StartedSignIn>> {
  const m = getConnector(connectorId);
  if (!m) return refused(404, "not_found");
  if (actor.kind !== "human" || !actor.uid || !can(actor, "connect")) return refused(403, "forbidden");
  const method = oauthMethod(m);
  // Listed for another method (share access) while this sign in's own switch is off.
  if (!method || !methodSwitchOn(method)) return refused(400, "method_not_supported");
  const parsed = StartBodySchema.safeParse(body ?? {});
  if (!parsed.success) return refused(400, "invalid_input");
  const client = googleClient();
  if (!client) return refused(503, "signin_unconfigured", connectorMessage("signin_unconfigured"));
  if (!isVaultConfigured()) return refused(503, "vault_unconfigured", connectorMessage("vault_unconfigured"));
  const origin = connectorsOrigin(headers);
  if (!origin) return refused(503, "signin_unconfigured", "This copy of YouGrow has no sign in address set (CONNECTORS_OAUTH_ORIGIN). Ask whoever runs it to set one.");

  const connectionId = parsed.data.connectionId ?? null;
  if (connectionId) {
    const conn = await forTenant(ctx, deps.db).dataConnections.getById(connectionId);
    if (!conn || conn.connectorId !== m.id || conn.status !== "connected") return refused(404, "not_found");
    // A part's sign in is its organisation's: a brand admin's own Google tokens never go on it.
    if (conn.source) return refused(409, "managed_by_organisation", connectorMessage("managed_by_organisation"));
    if (conn.method !== "oauth_pkce") return refused(400, "method_not_supported");
  }

  const now = deps.now ?? new Date();
  const nonce = randomBytes(32).toString("base64url");
  const { verifier, challenge } = generatePkce();
  await createConnectionState(ctx, { id: stateIdOf(nonce), connectorId: m.id, uid: actor.uid, connectionId, createdAt: now.toISOString() }, deps.db);
  const state = signConnectorState({ t: ctx.tenantId, c: m.id, n: nonce, u: actor.uid, ts: now.getTime() });
  return {
    ok: true,
    status: 200,
    value: {
      url: googleAuthorizeUrl({ clientId: client.clientId, redirectUri: `${origin}${CALLBACK_PATH}`, scope: method.scopes[0]!, state, codeChallenge: challenge }),
      cookie: {
        name: stateCookieName(nonce),
        value: `${nonce}.${verifier}`,
        path: CALLBACK_PATH,
        maxAge: COOKIE_MAX_AGE_SEC,
        secure: origin.startsWith("https:"),
        httpOnly: true,
        sameSite: "lax",
      },
    },
  };
}

// --- Finish ------------------------------------------------------------------------------------

export type FinishedSignIn =
  | { ok: true; connectorId: string; connectionId: string; reconnected: boolean; cookieName: string }
  | { ok: false; reason: SignInReason; connectorId: string | null; cookieName: string | null };

interface SignedState {
  t: string;
  c: string;
  n: string;
  u: string;
  ts: number;
}

function readState(raw: string | null): SignedState | null {
  if (!raw || raw.length > 2048) return null;
  const s = verifyConnectorState(raw);
  if (!s) return null;
  const { t, c, n, u, ts } = s as Partial<SignedState>;
  if (typeof t !== "string" || typeof c !== "string" || typeof u !== "string" || typeof ts !== "number" || typeof n !== "string" || !NONCE_RE.test(n)) return null;
  return { t, c, n, u, ts };
}

/** A cookie's value from the Cookie header, by exact name. */
function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Finish a sign in where Google sent the browser back. Checks, in order: the signed state, its
 * brand, its admin, its age, the browser's cookie, Google's own answer, the connector, then claims
 * the server record once; only then swaps the code, checks the scope granted and the refresh token,
 * runs the verify request and saves. Never throws for a refusal; each comes back as a reason.
 */
export async function finishSignIn(
  ctx: TenantContext,
  actor: ConnectorActor,
  input: { query: URLSearchParams; cookieHeader: string | null; headers: Headers },
  deps: SignInDeps = {},
): Promise<FinishedSignIn> {
  const now = deps.now ?? new Date();
  const state = readState(input.query.get("state"));
  if (!state) return { ok: false, reason: "bad_state", connectorId: null, cookieName: null };
  const cookieName = stateCookieName(state.n);
  const connectorId = knownConnector(state.c) ? state.c : null;
  const fail = (reason: SignInReason): FinishedSignIn => ({ ok: false, reason, connectorId, cookieName });

  if (state.t !== ctx.tenantId) return fail("bad_state");
  const uid = actor.kind === "human" ? actor.uid : "";
  if (!uid || !can(actor, "connect")) return fail("forbidden");
  if (!sameText(state.u, uid)) return fail("wrong_admin");
  if (now.getTime() - state.ts > STATE_VALID_MS || state.ts - now.getTime() > FUTURE_SKEW_MS) return fail("state_expired");

  // The browser that started: its cookie holds this state's nonce and the PKCE verifier.
  const cookie = cookieValue(input.cookieHeader, cookieName) ?? "";
  const dot = cookie.indexOf(".");
  const cookieNonce = dot > 0 ? cookie.slice(0, dot) : "";
  const verifier = dot > 0 ? cookie.slice(dot + 1) : "";
  if (!verifier || !sameText(cookieNonce, state.n)) return fail("wrong_browser");

  const stateId = stateIdOf(state.n);
  const googleError = input.query.get("error");
  if (googleError) {
    await consumeConnectionState(ctx, stateId, { connectorId: state.c, uid }, now, deps.db).catch(() => null);
    return fail(googleError === "access_denied" ? "denied" : "google_error");
  }
  const m = getConnector(state.c);
  const method = m ? oauthMethod(m) : null;
  if (!m || !method || !methodSwitchOn(method)) return fail("connector_off");
  const code = input.query.get("code");
  if (!code || code.length > 2048) return fail("missing_code");

  const claimed = await consumeConnectionState(ctx, stateId, { connectorId: m.id, uid }, now, deps.db);
  if (!claimed.ok) return fail(claimed.why === "expired" ? "state_expired" : claimed.why === "mismatch" ? "bad_state" : "state_used");

  const client = googleClient();
  const origin = connectorsOrigin(input.headers);
  if (!client || !origin) return fail("signin_unconfigured");
  if (!isVaultConfigured()) return fail("vault_unconfigured");

  const swapped = await exchangeGoogleCode({ code, redirectUri: `${origin}${CALLBACK_PATH}`, codeVerifier: verifier }, client, deps);
  if (!swapped.ok) return fail("exchange_failed");
  const tokens = swapped.tokens;
  const granted = new Set(tokens.scopes);
  if (!method.scopes.every((s) => granted.has(s))) return fail("scope_not_granted");
  if ([...granted].some((s) => !method.scopes.includes(s))) return fail("scope_too_wide");
  if (!tokens.refreshToken) return fail("no_refresh_token");

  const prior = claimed.state.connectionId ? await forTenant(ctx, deps.db).dataConnections.getById(claimed.state.connectionId) : null;
  // A part (a record with a source) is never signed in again here: its sign in is its organisation's.
  if (prior?.source) return fail("bad_state");
  const again = prior && prior.connectorId === m.id && prior.method === "oauth_pkce" && prior.status === "connected" ? prior : null;
  const id = again ? again.id : (deps.newId ?? newDataConnectionId)();
  const account = again?.account ?? "";

  const verify = VERIFY_HOOKS[m.verify.hook];
  if (!verify) return fail("connector_off");
  const checked = await verify({ manifest: m, connection: { id, tenantId: ctx.tenantId, pausedAt: null, health: healthyAt(now) }, account, token: tokens.accessToken }, deps);
  if (!checked.ok) return fail(checked.code === "account_refused" && account ? "site_not_visible" : "check_failed");

  const at = now.toISOString();
  const secrets = {
    [ACCESS_SLOT]: sealConnectorSecret(ctx.tenantId, id, ACCESS_SLOT, tokens.accessToken, now),
    [REFRESH_SLOT]: sealConnectorSecret(ctx.tenantId, id, REFRESH_SLOT, tokens.refreshToken, now),
  };
  const signedIn = { secrets, tokenExpiresAt: tokens.expiresAt, refresh: { leaseId: null, leaseUntil: null }, health: healthyAt(now) };

  if (again) {
    const r = await changeDataConnection(
      ctx,
      id,
      (cur) => (cur.status === "connected" ? { patch: signedIn, activity: [{ kind: "connected", by: uid, at, code: "signed_in_again" }] } : null),
      deps.db,
    );
    if (r.ok) return { ok: true, connectorId: m.id, connectionId: id, reconnected: true, cookieName };
    return fail("check_failed");
  }
  await saveNew(ctx, m, id, uid, at, signedIn, deps);
  return { ok: true, connectorId: m.id, connectionId: id, reconnected: false, cookieName };
}

async function saveNew(
  ctx: TenantContext,
  m: ConnectorManifest,
  id: string,
  uid: string,
  at: string,
  signedIn: Pick<DataConnection, "secrets" | "tokenExpiresAt" | "refresh" | "health">,
  deps: SignInDeps,
): Promise<void> {
  await createDataConnection(
    ctx,
    {
      id,
      connectorId: m.id,
      method: "oauth_pkce",
      label: m.name,
      account: "",
      ownerUid: uid,
      grants: [],
      ...signedIn,
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: at,
      updatedAt: at,
      disconnectedAt: null,
    },
    [{ kind: "connected", by: uid, at }],
    deps.db,
  );
}
