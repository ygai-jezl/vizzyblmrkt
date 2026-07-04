import type { TenantContext } from "@/lib/tenant/types";
import type { SocialConnection, Tenant } from "@/lib/types/tenant";
import { setTenantSocialConnection } from "@/lib/tenant";
import { encryptToken } from "./crypto";
import { getDecryptedSocialTokens } from "./connections";
import {
  X_TOKEN_URL,
  basicAuthHeader,
  xClientId,
  xClientSecret,
  type XTokenResponse,
} from "./x/oauth";
import {
  LINKEDIN_TOKEN_URL,
  linkedinClientId,
  linkedinClientSecret,
  linkedinCmClientId,
  linkedinCmClientSecret,
  type LinkedInTokenResponse,
} from "./linkedin/oauth";

/**
 * OAuth 2.0 refresh-token exchange for the social publishers, and the
 * `ensureFreshAccessToken` gate the Distribute worker calls before every send.
 *
 * WHY THIS EXISTS: access tokens are short-lived (X ~2h; LinkedIn ~60 days) but the
 * worker publishes on a delay — a post scheduled hours ahead, and ESPECIALLY the
 * Auto-Plug (+24h) / performance-fetch (+48h) follow-up jobs, will almost always run
 * with an expired access token. Without a refresh the send 401s and parks until the
 * operator reconnects. `ensureFreshAccessToken` transparently refreshes (using the
 * stored `offline.access` refresh token) and persists the rotated token, so scheduled
 * publishing keeps working across the token lifetime.
 *
 * FAIL-SOFT: refresh is best-effort. If it can't refresh (not configured, network,
 * revoked refresh token) it returns the CURRENT (likely-expired) access token — the
 * publish then 401s and parks exactly as it would have, and the operator reconnects.
 * A refresh never throws, so it can't turn a benign token expiry into a worker retry.
 */

/** Platforms that issue a refresh token we can exchange. (Instagram: Phase 5.) */
export type RefreshablePlatform = "x" | "linkedin" | "linkedin_org";

export interface RefreshDeps {
  fetch?: typeof fetch;
}

export interface RefreshedBundle {
  accessToken: string;
  /** A rotated refresh token if the platform issued one (X + LinkedIn both rotate);
   *  null → keep the existing one. */
  refreshToken: string | null;
  /** ISO expiry, or null if the platform returned no `expires_in`. */
  expiresAt: string | null;
  /** Granted scope echoed back, or null. */
  scope: string | null;
}

export type RefreshResult =
  | { ok: true; bundle: RefreshedBundle }
  | { ok: false; reason: string };

/** Refresh sooner than expiry so a token that lapses mid-run is renewed proactively. */
const REFRESH_SKEW_MS = 5 * 60 * 1000; // 5 min

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "error";
}

function expiresAtFrom(expiresIn: number | undefined): string | null {
  return typeof expiresIn === "number" && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;
}

/** X OAuth 2.0 refresh — confidential client → Basic auth + refresh_token grant. */
async function refreshX(refreshToken: string, doFetch: typeof fetch): Promise<RefreshResult> {
  const cid = xClientId();
  const csec = xClientSecret();
  if (!cid || !csec) return { ok: false, reason: "x_not_configured" };
  let res: Response;
  try {
    res = await doFetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: basicAuthHeader(cid, csec),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: cid,
      }).toString(),
    });
  } catch (e) {
    return { ok: false, reason: `x_network:${errMsg(e)}` };
  }
  if (!res.ok) return { ok: false, reason: `x_api_${res.status}` };
  let tok: XTokenResponse;
  try {
    tok = (await res.json()) as XTokenResponse;
  } catch {
    return { ok: false, reason: "x_parse" };
  }
  if (!tok.access_token) return { ok: false, reason: "x_no_token" };
  return {
    ok: true,
    bundle: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
    },
  };
}

/** LinkedIn OAuth 2.0 refresh — client_id/secret in the BODY (no Basic, no PKCE). The
 *  same endpoint serves both apps; the caller passes the right app's credentials. */
async function refreshLinkedIn(
  refreshToken: string,
  cid: string | undefined,
  csec: string | undefined,
  doFetch: typeof fetch,
): Promise<RefreshResult> {
  if (!cid || !csec) return { ok: false, reason: "linkedin_not_configured" };
  let res: Response;
  try {
    res = await doFetch(LINKEDIN_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: cid,
        client_secret: csec,
      }).toString(),
    });
  } catch (e) {
    return { ok: false, reason: `linkedin_network:${errMsg(e)}` };
  }
  if (!res.ok) return { ok: false, reason: `linkedin_api_${res.status}` };
  let tok: LinkedInTokenResponse;
  try {
    tok = (await res.json()) as LinkedInTokenResponse;
  } catch {
    return { ok: false, reason: "linkedin_parse" };
  }
  if (!tok.access_token) return { ok: false, reason: "linkedin_no_token" };
  return {
    ok: true,
    bundle: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: expiresAtFrom(tok.expires_in),
      scope: tok.scope ?? null,
    },
  };
}

/** Exchange a refresh token for a fresh access token bundle. Never throws. */
export async function refreshSocialToken(
  platform: RefreshablePlatform,
  refreshToken: string,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const doFetch = deps.fetch ?? fetch;
  if (!refreshToken) return { ok: false, reason: "no_refresh_token" };
  switch (platform) {
    case "x":
      return refreshX(refreshToken, doFetch);
    case "linkedin":
      return refreshLinkedIn(refreshToken, linkedinClientId(), linkedinClientSecret(), doFetch);
    case "linkedin_org":
      return refreshLinkedIn(refreshToken, linkedinCmClientId(), linkedinCmClientSecret(), doFetch);
  }
}

export interface EnsureFreshDeps extends RefreshDeps {
  /** Injectable clock (ms) — tests drive expiry deterministically. */
  now?: () => number;
  /** Injectable persistence — defaults to writing the tenant control doc. */
  persist?: (platform: RefreshablePlatform, conn: SocialConnection) => Promise<void>;
}

/**
 * Return a VALID access token for the tenant's platform connection, refreshing (and
 * persisting the rotated token) when it's at/near expiry. Returns null only when the
 * platform isn't connected (or crypto is unset) — the caller parks as "not connected".
 *
 * Refresh is FAIL-SOFT (see the module header): on any refresh error it returns the
 * current token and lets the publish decide (a real 401 parks; a still-valid token
 * simply works). Persist failure is likewise swallowed — the in-memory token is used
 * for THIS send and re-refreshed next run.
 *
 * ROTATION CAVEAT: X invalidates the old refresh token on every refresh. If the
 * refresh succeeds but the persist fails, the next run's stored refresh token is stale
 * and its refresh will fail → the connection needs reconnecting. The persist is a
 * single control-doc update (rarely fails); a hard failure is logged loudly.
 * CONCURRENCY CAVEAT: two overlapping cron runs draining the same tenant can refresh
 * the same connection near-simultaneously; with X's one-time refresh tokens the loser's
 * refresh 400s and fail-softs to a stale token → that one post parks (retryable once the
 * winner persisted). Rare (only within REFRESH_SKEW of expiry) and self-healing.
 */
export async function ensureFreshAccessToken(
  ctx: TenantContext,
  platform: RefreshablePlatform,
  tenant: Tenant | null,
  deps: EnsureFreshDeps = {},
): Promise<string | null> {
  const conn = tenant?.socialConnections?.[platform] ?? null;
  const tokens = getDecryptedSocialTokens(tenant, platform);
  if (!conn || !tokens) return null; // not connected / crypto unset

  const nowMs = deps.now?.() ?? Date.now();
  // Decide whether to refresh:
  //  • expiresAt ABSENT (null) → no expiry tracked → don't proactively refresh (assume
  //    long-lived; it fail-softs if it later lapses).
  //  • expiresAt present + parseable → refresh once within REFRESH_SKEW of expiry.
  //  • expiresAt present but UNPARSEABLE (corrupt stored data) → treat as expired and
  //    refresh, so a bad value self-heals instead of silently disabling refresh forever.
  let needsRefresh: boolean;
  if (conn.expiresAt == null) {
    needsRefresh = false;
  } else {
    const expMs = Date.parse(conn.expiresAt);
    needsRefresh = !Number.isFinite(expMs) || expMs - nowMs <= REFRESH_SKEW_MS;
  }
  // Not due, or no refresh token to spend → use as-is.
  if (!needsRefresh || !tokens.refreshToken) return tokens.accessToken;

  const res = await refreshSocialToken(platform, tokens.refreshToken, deps);
  if (!res.ok) {
    console.warn(`[social-refresh] ${platform} refresh failed for ${ctx.tenantId}: ${res.reason}`);
    return tokens.accessToken; // fail-soft — publish parks on a real 401
  }

  const updated: SocialConnection = {
    ...conn,
    enc: encryptToken(res.bundle.accessToken),
    // Keep the prior refresh token if the platform didn't rotate one this time.
    refreshEnc: res.bundle.refreshToken
      ? encryptToken(res.bundle.refreshToken)
      : conn.refreshEnc ?? null,
    // A refresh with no new expiry → null (unknown), NOT the old (now-past) expiry:
    // reusing the stale value would force a needless re-refresh on the very next run.
    expiresAt: res.bundle.expiresAt ?? null,
    scope: res.bundle.scope ?? conn.scope,
  };
  const persist =
    deps.persist ?? ((p, c) => setTenantSocialConnection(ctx.tenantId, p, c));
  try {
    await persist(platform, updated);
  } catch (e) {
    console.warn(`[social-refresh] ${platform} persist failed for ${ctx.tenantId}: ${errMsg(e)}`);
  }
  return res.bundle.accessToken;
}
