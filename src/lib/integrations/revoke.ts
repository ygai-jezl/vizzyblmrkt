import type { GitConnection } from "@/lib/types/tenant";
import { decryptToken, gitRefreshAad } from "./crypto";
import { PROVIDERS, githubTokenRevokeUrl, type GitProvider } from "./providers";

/**
 * Cancel YouGrow's access at the provider when a git connection goes away (Disconnect)
 * or is replaced (a reconnect, or the switch to the GitHub App). Callers check
 * isConnectorRevokeEnabled() (src/lib/integrations/flags.ts) and call this only AFTER
 * the local delete or save, so a slow or failing provider never keeps a connection.
 *
 * Policy:
 *  - GitLab: POST /oauth/revoke with the refresh token when there is one, else the
 *    access token. Either one ends the same grant.
 *  - Classic GitHub (an older OAuth connection): DELETE /applications/{client_id}/token
 *    for that one token. Never /grant, which would end every brand's token for that
 *    GitHub user.
 *  - A GitHub App installation is never uninstalled: other brands may use it.
 *
 * Best effort: never throws, gives up after REVOKE_TIMEOUT_MS. Logs say "[revoke]" and
 * the reason, never a token.
 */

export const REVOKE_TIMEOUT_MS = 8_000;

export type RevokeOutcome = "done" | "failed" | "skipped";
export interface RevokeResult {
  result: RevokeOutcome;
  /** Why it failed or was skipped. Never a token. */
  reason?: string;
}

export interface RevokeDeps {
  fetch?: typeof fetch;
  /** Tests shorten the timeout. */
  timeoutMs?: number;
}

interface OpenedGitTokens {
  provider: GitProvider;
  accessToken: string;
  refreshToken: string | null;
}

type Opened = { ok: true; tokens: OpenedGitTokens } | { ok: false; skipped: RevokeResult };

const skipped = (reason: string): RevokeResult => ({ result: "skipped", reason });

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "error";
}

/** The tokens a stored connection holds, decrypted in memory. A GitHub App, a missing
 *  token or one that won't open here (wrong key, or sealed for another brand) skips. */
function openGitTokens(tenantId: string, conn: GitConnection | null | undefined): Opened {
  if (!conn) return { ok: false, skipped: skipped("not_connected") };
  if (conn.kind === "app") return { ok: false, skipped: skipped("github_app") };
  if (!conn.enc) return { ok: false, skipped: skipped("no_token") };
  try {
    return {
      ok: true,
      tokens: {
        provider: conn.provider,
        accessToken: decryptToken(conn.enc),
        refreshToken: conn.refreshEnc ? decryptToken(conn.refreshEnc, gitRefreshAad(tenantId, conn.provider)) : null,
      },
    };
  } catch {
    return { ok: false, skipped: skipped("unreadable") };
  }
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/** The provider request for these tokens, or a skip when the provider isn't set up. */
function revokeRequest(t: OpenedGitTokens): { url: string; init: RequestInit } | RevokeResult {
  const cfg = PROVIDERS[t.provider];
  const clientId = cfg.clientId();
  const clientSecret = cfg.clientSecret();
  if (!clientId || !clientSecret) return skipped("not_configured");
  if (t.provider === "gitlab") {
    if (!cfg.revokeUrl) return skipped("not_configured");
    const useRefresh = Boolean(t.refreshToken);
    return {
      url: cfg.revokeUrl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          token: useRefresh ? t.refreshToken! : t.accessToken,
          token_type_hint: useRefresh ? "refresh_token" : "access_token",
        }).toString(),
      },
    };
  }
  return {
    url: githubTokenRevokeUrl(clientId),
    init: {
      method: "DELETE",
      headers: {
        Authorization: basicAuth(clientId, clientSecret),
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "YouGrow",
      },
      body: JSON.stringify({ access_token: t.accessToken }),
    },
  };
}

async function revokeOpened(tenantId: string, t: OpenedGitTokens, deps: RevokeDeps): Promise<RevokeResult> {
  const req = revokeRequest(t);
  if ("result" in req) return req;
  let outcome: RevokeResult;
  try {
    const res = await (deps.fetch ?? fetch)(req.url, {
      ...req.init,
      signal: AbortSignal.timeout(deps.timeoutMs ?? REVOKE_TIMEOUT_MS),
    });
    outcome = res.ok ? { result: "done" } : { result: "failed", reason: `api_${res.status}` };
  } catch (e) {
    const name = errName(e);
    outcome = { result: "failed", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : `network:${name}` };
  }
  if (outcome.result === "failed") {
    console.warn(`[revoke] ${t.provider} revoke failed for ${tenantId}: ${outcome.reason}`);
  }
  return outcome;
}

/**
 * Revoke the token a git connection held, at its provider. Pass the connection as it
 * was read before the local delete. Never throws.
 */
export async function revokeGitConnection(
  tenantId: string,
  conn: GitConnection | null | undefined,
  deps: RevokeDeps = {},
): Promise<RevokeResult> {
  try {
    const opened = openGitTokens(tenantId, conn);
    if (!opened.ok) return opened.skipped;
    return await revokeOpened(tenantId, opened.tokens, deps);
  } catch (e) {
    console.warn(`[revoke] git revoke failed for ${tenantId}: ${errName(e)}`);
    return { result: "failed", reason: "exception" };
  }
}

/**
 * After a reconnect or the switch to the GitHub App replaced a stored connection,
 * revoke the token it held, but only when that token differs from the new one. A
 * provider may hand back the same token (or the same refresh token) on reconnect, and
 * revoking it would cut off the connection that was just saved. A GitHub App
 * connection has no token, so `next` is all null. Never throws.
 */
export async function revokeReplacedGitConnection(
  tenantId: string,
  prior: GitConnection | null | undefined,
  next: { accessToken: string | null; refreshToken: string | null },
  deps: RevokeDeps = {},
): Promise<RevokeResult> {
  try {
    const opened = openGitTokens(tenantId, prior);
    if (!opened.ok) return opened.skipped;
    const old = opened.tokens;
    const same =
      (next.accessToken !== null && old.accessToken === next.accessToken) ||
      (next.refreshToken !== null && old.refreshToken !== null && old.refreshToken === next.refreshToken);
    if (same) return skipped("same_token");
    return await revokeOpened(tenantId, old, deps);
  } catch (e) {
    console.warn(`[revoke] git revoke failed for ${tenantId}: ${errName(e)}`);
    return { result: "failed", reason: "exception" };
  }
}
