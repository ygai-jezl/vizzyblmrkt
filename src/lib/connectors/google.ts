import { readBytesUpTo } from "@/lib/security/ssrf";
import type { ConnectorErrorCode } from "./messages";
import { codeForThrow, defaultTransport, retryAfter, type Transport } from "./safeFetch";

/**
 * Google's sign in endpoints for connected data (Connectors 1b, ADR-0011), grounded in Google's
 * "Using OAuth 2.0 for Web Server Applications" (developers.google.com/identity/protocols/oauth2/
 * web-server):
 *
 * - The authorization code flow with `access_type=offline` (a refresh token) and `prompt=consent`
 *   (a refresh token on every sign in, not only the first), one scope per connection, and no
 *   `include_granted_scopes`, so a token never carries scopes another connection asked for.
 * - PKCE S256 is sent as well. Google documents it for installed apps; the dev check confirms the
 *   web client accepts it. The signed state and the browser nonce bind the browser either way.
 * - The token endpoint's `scope` is what was granted; the caller checks it.
 * - A refresh may come back without a refresh token; the caller keeps the one it has.
 * - Revoking ends every grant that Google account gave this app, for every brand, so it runs only
 *   behind CONNECTOR_GOOGLE_REVOKE_ENABLED.
 *
 * The client is CONNECTOR_GOOGLE_CLIENT_ID with the secret CONNECTOR_GOOGLE_CLIENT_SECRET, a web
 * client in a Google project of its own, so the app's own admin sign in (Firebase Auth) is never
 * put through Google's verification. Calls go out through src/lib/security/ssrf.ts safeFetch to
 * oauth2.googleapis.com only, with no redirects, on 443, with a timeout and a capped body. Logs
 * name the host and a code, never a token, a code or a secret. Nothing here throws.
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;
/** Used when Google leaves out expires_in: its access tokens last an hour. */
const DEFAULT_EXPIRES_SEC = 3600;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface GoogleDeps {
  transport?: Transport;
  log?: (line: string) => void;
  now?: Date;
}

/** The connectors' Google client, or null when either half is unset. */
export function googleClient(): GoogleClient | null {
  const clientId = (process.env.CONNECTOR_GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.CONNECTOR_GOOGLE_CLIENT_SECRET ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function isGoogleSignInConfigured(): boolean {
  return googleClient() !== null;
}

/** Google's authorize address for one sign in. */
export function googleAuthorizeUrl(input: { clientId: string; redirectUri: string; scope: string; state: string; codeChallenge: string }): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface GoogleTokens {
  accessToken: string;
  /** Null when Google sent none (a refresh usually doesn't). */
  refreshToken: string | null;
  /** Canonical ISO instant. */
  expiresAt: string;
  /** What was granted, from the response's space separated `scope`. */
  scopes: string[];
}

export type GoogleTokenResult = { ok: true; tokens: GoogleTokens } | { ok: false; code: ConnectorErrorCode; retryAfterSec: number | null };

type Posted = { ok: true; status: number; body: unknown; retryAfterSec: number | null } | { ok: false; code: ConnectorErrorCode };

async function postForm(url: string, form: Record<string, string>, deps: GoogleDeps): Promise<Posted> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const host = new URL(url).hostname;
  let res: Response;
  try {
    res = await (deps.transport ?? defaultTransport)(
      url,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString() },
      { maxRedirects: 0, allowedPorts: [443], timeoutMs: TIMEOUT_MS },
    );
  } catch (err) {
    const code = codeForThrow(err);
    log(`[connectors] google ${host} ${code}`);
    return { ok: false, code };
  }
  if (res.status >= 300 && res.status < 400) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    log(`[connectors] google ${host} redirect_refused ${res.status}`);
    return { ok: false, code: "redirect_refused" };
  }
  let body: unknown = null;
  try {
    const { bytes, truncated } = await readBytesUpTo(res, MAX_BYTES);
    body = truncated || !bytes.length ? null : JSON.parse(bytes.toString("utf8"));
  } catch {
    body = null;
  }
  return { ok: true, status: res.status, body, retryAfterSec: res.status === 429 ? retryAfter(res) : null };
}

/** The code for a refused token request, from Google's `error` field. */
export function tokenFailureCode(status: number, body: unknown): ConnectorErrorCode {
  const error = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
  if (error === "invalid_grant") return "signin_refused";
  if (error === "invalid_client" || error === "unauthorized_client" || status === 401) return "signin_unconfigured";
  if (status === 429) return "rate_limited";
  return "provider_error";
}

function tokensFrom(body: unknown, now: Date): GoogleTokens | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  if (typeof b.access_token !== "string" || !b.access_token) return null;
  const expiresIn = typeof b.expires_in === "number" && Number.isFinite(b.expires_in) && b.expires_in > 0 ? b.expires_in : DEFAULT_EXPIRES_SEC;
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    scopes: typeof b.scope === "string" ? b.scope.split(/\s+/).filter(Boolean) : [],
  };
}

async function tokenCall(form: Record<string, string>, deps: GoogleDeps): Promise<GoogleTokenResult> {
  const posted = await postForm(GOOGLE_TOKEN_URL, form, deps);
  if (!posted.ok) return { ok: false, code: posted.code, retryAfterSec: null };
  if (posted.status < 200 || posted.status >= 300) {
    const code = tokenFailureCode(posted.status, posted.body);
    (deps.log ?? ((line: string) => console.warn(line)))(`[connectors] google oauth2.googleapis.com ${code} ${posted.status}`);
    return { ok: false, code, retryAfterSec: posted.retryAfterSec };
  }
  const tokens = tokensFrom(posted.body, deps.now ?? new Date());
  return tokens ? { ok: true, tokens } : { ok: false, code: "bad_response", retryAfterSec: null };
}

/** Swap the code Google sent to the callback for tokens, with the PKCE verifier. */
export function exchangeGoogleCode(input: { code: string; redirectUri: string; codeVerifier: string }, client: GoogleClient, deps: GoogleDeps = {}): Promise<GoogleTokenResult> {
  return tokenCall(
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
    deps,
  );
}

/** A new access token from a refresh token. invalid_grant comes back as signin_refused. */
export function refreshGoogleToken(refreshToken: string, client: GoogleClient, deps: GoogleDeps = {}): Promise<GoogleTokenResult> {
  return tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, deps);
}

/**
 * Revoke a Google token. Google ends the whole grant: every access and refresh token that Google
 * account gave this app, for every brand. Callers check CONNECTOR_GOOGLE_REVOKE_ENABLED first.
 * True when Google answered 200.
 */
export async function revokeGoogleToken(token: string, deps: GoogleDeps = {}): Promise<boolean> {
  if (!token) return false;
  const posted = await postForm(GOOGLE_REVOKE_URL, { token }, deps);
  if (posted.ok && posted.status === 200) return true;
  (deps.log ?? ((line: string) => console.warn(line)))(`[connectors] google oauth2.googleapis.com revoke_failed${posted.ok ? ` ${posted.status}` : ` ${posted.code}`}`);
  return false;
}
