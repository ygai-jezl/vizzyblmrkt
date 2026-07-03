import { createHash, randomBytes } from "node:crypto";
import { oauthOrigin } from "@/lib/integrations/providers";

/**
 * X (Twitter) OAuth 2.0 Authorization Code + PKCE config + pure helpers. The app is
 * a CONFIDENTIAL client (server holds the secret), so the token exchange also uses
 * HTTP Basic auth — but PKCE is still required by X. Grounded in docs.x.com/x-api.
 */

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_ME_URL = "https://api.x.com/2/users/me";
/** tweet.write to publish, tweet.read/users.read for /users/me, offline.access for refresh. */
export const X_SCOPES = "tweet.read tweet.write users.read offline.access";
/** httpOnly cookie carrying `<state-nonce>.<pkce-verifier>` from /start to /callback. */
export const X_PKCE_COOKIE = "x_pkce";
/** Cookie path — scoped to the CALLBACK only (the sole reader of the verifier). */
export const X_OAUTH_PATH = "/api/admin/integrations/x/callback";

/**
 * Server-trusted origin for the X OAuth redirect_uri + return redirect. Prefers a
 * social-specific pin (SOCIAL_OAUTH_ORIGIN) so it isn't coupled to the git-named
 * GIT_OAUTH_ORIGIN; falls back to that, then the request origin (local dev). Pin it
 * in prod so a spoofed Host header can't influence redirect_uri.
 */
export function socialOrigin(headers: Headers): string {
  const pinned = (process.env.SOCIAL_OAUTH_ORIGIN ?? "").replace(/\/+$/, "");
  if (pinned) return pinned;
  return oauthOrigin(headers);
}

export function xClientId(): string | undefined {
  return process.env.X_OAUTH_CLIENT_ID;
}
export function xClientSecret(): string | undefined {
  return process.env.X_OAUTH_CLIENT_SECRET;
}

/** The X OAuth app is configured (client id + secret present). */
export function isXConfigured(): boolean {
  return Boolean(xClientId() && xClientSecret());
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE verifier + its S256 challenge (both base64url, unpadded). */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, within 43–128
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Build the X authorize URL for the redirect. */
export function buildXAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
}): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope ?? X_SCOPES);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** HTTP Basic auth header value for the confidential-client token exchange. */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export interface XTokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
}
