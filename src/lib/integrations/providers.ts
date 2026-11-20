/**
 * GitHub / GitLab OAuth provider config for the per-tenant git connection used to
 * clone PRIVATE repos. client id/secret come from env (Secret Manager). Scopes:
 * GitHub `repo` (read private repos); GitLab `read_repository read_user`.
 */
import { originFromHeaders } from "@/lib/http/origin";

export type GitProvider = "github" | "gitlab";

export interface ProviderConfig {
  id: GitProvider;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  userApiUrl: string;
  /** Space-separated OAuth scopes requested at authorize time. */
  scope: string;
  /** The single scope that MUST be granted for a private clone to work. */
  requiredScope: string;
  /** Extra scope needed to LIST the account's repos (repo selection), if `scope`
   *  doesn't already cover it. */
  listScope?: string;
  /** Field on the user API response that holds the account handle. */
  loginField: string;
  /** OAuth token revocation endpoint (RFC 7009), when the provider has one we use.
   *  Classic GitHub uses githubTokenRevokeUrl instead. */
  revokeUrl?: string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
}

export const PROVIDERS: Record<GitProvider, ProviderConfig> = {
  github: {
    id: "github",
    label: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userApiUrl: "https://api.github.com/user",
    scope: "repo",
    requiredScope: "repo",
    loginField: "login",
    clientId: () => process.env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_OAUTH_CLIENT_SECRET,
  },
  gitlab: {
    id: "gitlab",
    label: "GitLab",
    authorizeUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    userApiUrl: "https://gitlab.com/api/v4/user",
    scope: "read_repository read_user",
    requiredScope: "read_repository",
    // read_repository/read_user don't cover GET /projects.
    listScope: "read_api",
    loginField: "username",
    revokeUrl: "https://gitlab.com/oauth/revoke",
    clientId: () => process.env.GITLAB_OAUTH_CLIENT_ID,
    clientSecret: () => process.env.GITLAB_OAUTH_CLIENT_SECRET,
  },
};

/**
 * Classic GitHub OAuth app: the endpoint that revokes ONE token
 * (DELETE /applications/{client_id}/token). Never /applications/{client_id}/grant,
 * which removes the app's grant for that GitHub user and so every brand's token.
 */
export function githubTokenRevokeUrl(clientId: string): string {
  return `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`;
}

export function isGitProvider(p: string): p is GitProvider {
  return p === "github" || p === "gitlab";
}

/**
 * httpOnly cookie carrying the state nonce from /start to /callback. The callback only
 * accepts a state whose nonce matches it, so a signed state can't be replayed in another
 * browser to attach someone else's account (OAuth account fixation). Its name differs
 * from the social ones (x_pkce, li_oauth_state, li_org_state).
 */
export const GIT_STATE_COOKIE = "git_oauth_state";

/** A provider's callback path: the redirect_uri path, and the nonce cookie's path, so
 *  GitHub's and GitLab's cookies never collide. */
export function gitCallbackPath(p: GitProvider): string {
  return `/api/admin/integrations/${p}/callback`;
}

/**
 * Server-trusted origin for the OAuth `redirect_uri`. Pinned via GIT_OAUTH_ORIGIN
 * so a spoofed `Host`/`x-forwarded-host` header can't redirect the auth code to an
 * attacker, and so the redirect_uri ALWAYS matches the single callback URL
 * registered on the OAuth app (custom tenant domains / apex-vs-www would otherwise
 * mismatch). The request host is routing-only and untrusted — see
 * src/lib/http/origin.ts. Falls back to the request origin only for local dev,
 * where the env is unset.
 */
export function oauthOrigin(headers: Headers): string {
  const pinned = (process.env.GIT_OAUTH_ORIGIN ?? "").replace(/\/+$/, "");
  if (pinned) return pinned;
  return originFromHeaders(headers);
}

/** Scopes to request at authorize time (+ the listing scope when repo selection is on). */
export function authorizeScope(p: GitProvider, repoSelection: boolean): string {
  const c = PROVIDERS[p];
  return repoSelection && c.listScope ? `${c.scope} ${c.listScope}` : c.scope;
}

/** Parse a provider scope string (space- or comma-separated) into a set. */
export function grantedScopes(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
}

/** True when this provider's OAuth app is configured (client id + secret present). */
export function isProviderConfigured(p: GitProvider): boolean {
  const c = PROVIDERS[p];
  return Boolean(c.clientId() && c.clientSecret());
}
