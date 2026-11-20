import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { GitConnection } from "@/lib/types/tenant";
import { getTenantById, markTenantGitReconnect, swapTenantGitToken } from "@/lib/tenant";
import { decryptToken, encryptToken, gitRefreshAad } from "./crypto";
import { PROVIDERS, gitCallbackPath, type GitProvider } from "./providers";

/**
 * GitLab access tokens last 2 hours, so the app refreshes a GitLab connection before
 * every use: listing repos, starting a knowledge ingest, and starting Learn from repo.
 * Modelled on src/lib/social/tokenRefresh.ts. Only the app refreshes (the knowledge
 * worker reads the stored access token as it is), so a refresh before a worker
 * trigger leaves a margin that outlasts the worker's run (WORKER_MIN_VALIDITY_MS).
 *
 * Every write is compare-and-set on the access token it replaces (src/lib/tenant/
 * control.ts), so overlapping refreshes settle on one stored token, a refresh never
 * brings back a disconnected account, and a slower request never marks a connection
 * another request has just refreshed.
 *
 * FAIL-SOFT: nothing here throws. A network error or a 5xx keeps the current token
 * with no mark (the provider may be down; the next use tries again). Only a refused
 * refresh (400 or 401) marks the connection as needing reconnecting. Logs say
 * "[git-refresh]" and never include a token.
 */

/** Refresh this long before expiry even when the caller asks for less. */
export const GIT_REFRESH_SKEW_MS = 5 * 60 * 1000;
/**
 * Before a worker trigger the token must have at least this long left. The worker
 * reads the token once per clone, at the start of each attempt; the Job has a 60
 * minute task timeout and one retry, so a retry clones at most about 60 minutes after
 * the trigger, leaving at least 30 minutes. A token just refreshed (about 120 minutes
 * left) isn't refreshed again by a trigger in the next 30 minutes.
 */
export const WORKER_MIN_VALIDITY_MS = 90 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

export interface GitRefreshDeps {
  fetch?: typeof fetch;
}

export interface GitRefreshedBundle {
  accessToken: string;
  /** A rotated refresh token (GitLab rotates them); null keeps the stored one. */
  refreshToken: string | null;
  /** ISO expiry, or null when the response had no expires_in. */
  expiresAt: string | null;
}

export type GitRefreshResult =
  | { ok: true; bundle: GitRefreshedBundle }
  | { ok: false; reason: string; status?: number };

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "error";
}

/** Exchange a GitLab refresh token for a new access token. Never throws. */
export async function refreshGitLabToken(
  refreshToken: string,
  deps: GitRefreshDeps & { now?: () => number } = {},
): Promise<GitRefreshResult> {
  const cfg = PROVIDERS.gitlab;
  const clientId = cfg.clientId();
  const clientSecret = cfg.clientSecret();
  if (!refreshToken) return { ok: false, reason: "no_refresh_token" };
  if (!clientId || !clientSecret) return { ok: false, reason: "gitlab_not_configured" };
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  // GitLab may check the redirect_uri the code was issued for. The callback uses the
  // pinned origin, so send the same; without a pinned origin (local runs) leave it out.
  const pinned = (process.env.GIT_OAUTH_ORIGIN ?? "").replace(/\/+$/, "");
  if (pinned) body.set("redirect_uri", `${pinned}${gitCallbackPath("gitlab")}`);

  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: `network:${errName(e)}` };
  }
  if (!res.ok) return { ok: false, reason: `api_${res.status}`, status: res.status };
  let tok: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try {
    tok = (await res.json()) as typeof tok;
  } catch {
    return { ok: false, reason: "parse" };
  }
  if (typeof tok.access_token !== "string" || !tok.access_token) return { ok: false, reason: "no_token" };
  const nowMs = deps.now?.() ?? Date.now();
  return {
    ok: true,
    bundle: {
      accessToken: tok.access_token,
      refreshToken: typeof tok.refresh_token === "string" && tok.refresh_token ? tok.refresh_token : null,
      expiresAt:
        typeof tok.expires_in === "number" && tok.expires_in > 0
          ? new Date(nowMs + tok.expires_in * 1000).toISOString()
          : null,
    },
  };
}

export interface EnsureFreshGitDeps extends GitRefreshDeps {
  /** Refresh when less than this is left (never less than GIT_REFRESH_SKEW_MS). */
  minValidityMs?: number;
  /** Injectable clock (ms). */
  now?: () => number;
  /** The control-plane database (tests pass a FakeFirestore). */
  db?: FirestoreLike;
}

export interface FreshGitToken {
  /** The access token to use, or null when there is none to use (app connection, no
   *  token, a token that won't open, or the connection was removed meanwhile). */
  token: string | null;
  /** The stored ciphertext of `token`, for compare-and-set writes after using it. */
  ct: string | null;
  /** True when this call found the connection needs reconnecting. */
  reconnect: boolean;
}

const NONE: FreshGitToken = { token: null, ct: null, reconnect: false };

/** The stored connection's token after another request changed it, or null when gone. */
async function storedToken(
  ctx: TenantContext,
  provider: GitProvider,
  db: FirestoreLike | undefined,
): Promise<FreshGitToken> {
  const conn = (await getTenantById(ctx.tenantId, db))?.gitConnections?.[provider];
  if (!conn?.enc || conn.kind === "app") return NONE;
  try {
    return { token: decryptToken(conn.enc), ct: conn.enc.ct, reconnect: Boolean(conn.reconnect) };
  } catch {
    return { token: null, ct: conn.enc.ct, reconnect: true };
  }
}

function isDue(conn: GitConnection, nowMs: number, minValidityMs: number): boolean {
  if (conn.expiresAt == null) return true; // unknown expiry: refresh rather than guess
  const expMs = Date.parse(conn.expiresAt);
  return !Number.isFinite(expMs) || expMs - nowMs <= Math.max(GIT_REFRESH_SKEW_MS, minValidityMs);
}

async function ensureFresh(
  ctx: TenantContext,
  provider: GitProvider,
  conn: GitConnection | null | undefined,
  deps: EnsureFreshGitDeps,
): Promise<FreshGitToken> {
  if (!conn || conn.kind === "app" || !conn.enc) return NONE;
  const startCt = conn.enc.ct;
  let current: string;
  try {
    current = decryptToken(conn.enc);
  } catch {
    return { token: null, ct: startCt, reconnect: true };
  }
  const asIs: FreshGitToken = { token: current, ct: startCt, reconnect: false };
  // Classic GitHub tokens don't expire; an older GitLab connection has no refresh token.
  if (provider !== "gitlab" || !conn.refreshEnc) return asIs;
  const nowMs = deps.now?.() ?? Date.now();
  if (!isDue(conn, nowMs, deps.minValidityMs ?? 0)) return asIs;

  const refused = async (why: string): Promise<FreshGitToken> => {
    // Another request may have refreshed first and spent the refresh token we read.
    const stored = await storedToken(ctx, provider, deps.db);
    if (stored.ct === null) return NONE;
    if (stored.ct !== startCt) return stored;
    console.warn(`[git-refresh] ${provider} refresh refused for ${ctx.tenantId}: ${why}`);
    await markTenantGitReconnect(ctx.tenantId, provider, startCt, "refresh_failed", deps.db);
    return { token: current, ct: startCt, reconnect: true };
  };

  let refreshToken: string;
  try {
    refreshToken = decryptToken(conn.refreshEnc, gitRefreshAad(ctx.tenantId, provider));
  } catch {
    // A refresh token that won't open here can never refresh: same as a refusal.
    return refused("refresh_token_unreadable");
  }

  const res = await refreshGitLabToken(refreshToken, { fetch: deps.fetch, now: () => nowMs });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) return refused(res.reason);
    console.warn(`[git-refresh] ${provider} refresh failed for ${ctx.tenantId}: ${res.reason}`);
    return asIs;
  }

  const enc = encryptToken(res.bundle.accessToken);
  const outcome = await swapTenantGitToken(
    ctx.tenantId,
    provider,
    startCt,
    {
      enc,
      // Keep the stored refresh token if GitLab didn't rotate it this time.
      refreshEnc: res.bundle.refreshToken
        ? encryptToken(res.bundle.refreshToken, gitRefreshAad(ctx.tenantId, provider))
        : conn.refreshEnc,
      expiresAt: res.bundle.expiresAt,
    },
    deps.db,
  ).catch((e: unknown) => {
    console.warn(`[git-refresh] ${provider} save failed for ${ctx.tenantId}: ${errName(e)}`);
    return "unsaved" as const;
  });
  if (outcome === "saved") return { token: res.bundle.accessToken, ct: enc.ct, reconnect: false };
  if (outcome === "gone") return NONE; // disconnected meanwhile: never use or store it
  if (outcome === "stale") return storedToken(ctx, provider, deps.db);
  // Not saved: the new token still works for this use, and the next use refreshes again.
  return { token: res.bundle.accessToken, ct: startCt, reconnect: false };
}

/**
 * A usable access token for a git connection, refreshing GitLab first when it expires
 * within max(5 minutes, minValidityMs). Callers keep their own not-connected and
 * GitHub App checks first: an app connection or one with no token gives token null.
 * Never throws.
 */
export async function ensureFreshGitToken(
  ctx: TenantContext,
  provider: GitProvider,
  conn: GitConnection | null | undefined,
  deps: EnsureFreshGitDeps = {},
): Promise<FreshGitToken> {
  try {
    return await ensureFresh(ctx, provider, conn, deps);
  } catch (e) {
    console.warn(`[git-refresh] ${provider} check failed for ${ctx.tenantId}: ${errName(e)}`);
    try {
      return conn?.enc && conn.kind !== "app"
        ? { token: decryptToken(conn.enc), ct: conn.enc.ct, reconnect: false }
        : NONE;
    } catch {
      return NONE;
    }
  }
}

/**
 * Before triggering the knowledge worker for a git repo: make sure the stored token
 * has at least WORKER_MIN_VALIDITY_MS left, because the worker can't refresh it.
 * Swallows everything: a failure here only means the worker uses what is stored.
 */
export async function prepareGitTokenForWorker(
  ctx: TenantContext,
  provider: GitProvider,
  opts: { db?: FirestoreLike } = {},
): Promise<void> {
  try {
    const conn = (await getTenantById(ctx.tenantId, opts.db))?.gitConnections?.[provider];
    if (!conn) return;
    await ensureFreshGitToken(ctx, provider, conn, { db: opts.db, minValidityMs: WORKER_MIN_VALIDITY_MS });
  } catch (e) {
    console.warn(`[git-refresh] ${provider} prepare failed for ${ctx.tenantId}: ${errName(e)}`);
  }
}
