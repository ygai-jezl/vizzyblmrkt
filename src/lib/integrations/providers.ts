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
  /** Field on the user API response that holds the account handle. */
  loginField: string;
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
    loginField: "username",
    clientId: () => process.env.GITLAB_OAUTH_CLIENT_ID,
    clientSecret: () => process.env.GITLAB_OAUTH_CLIENT_SECRET,
  },
};

export function isGitProvider(p: string): p is GitProvider {
  return p === "github" || p === "gitlab";
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

/** Parse a provider scope string (space- or comma-separated) into a set. */
export function grantedScopes(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
}

/** True when this provider's OAuth app is configured (client id + secret present). */
export function isProviderConfigured(p: GitProvider): boolean {
  const c = PROVIDERS[p];
  return Boolean(c.clientId() && c.clientSecret());
}
