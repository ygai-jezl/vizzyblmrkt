import { createSign } from "node:crypto";

/**
 * READ-ONLY GitHub access through a GitHub App.
 *
 * Classic OAuth's `repo` scope grants read AND write to every private repo the
 * user can reach, and GitHub has no read-only equivalent for it. We promise
 * customers we never change their code, so GitHub access goes through a GitHub
 * App registered with only `Contents: read` and `Metadata: read`:
 *
 *  - the customer installs the app on the repos they choose (and can revoke it
 *    in GitHub at any time);
 *  - we store only the installation id — not a secret, no long-lived token;
 *  - each clone mints a ONE-HOUR installation token, down-scoped again to
 *    contents:read, signed with the app's private key (Secret Manager).
 *
 * Connecting proves the installation is the signed-in user's: GitHub's
 * "request user authorization during installation" returns a code, we exchange
 * it for a user token and confirm the installation is in /user/installations —
 * so nobody can attach an installation id they don't have access to. The user
 * token is used once and discarded.
 */

export interface GitHubAppConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
}

const API = "https://api.github.com";
const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "YouGrow-Connect",
};

export function githubAppConfig(env: Record<string, string | undefined> = process.env): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!appId || !slug || !clientId || !clientSecret || !privateKey) return null;
  if (!/^\d+$/.test(appId) || !/^[a-z0-9-]{1,100}$/.test(slug)) return null;
  return { appId, slug, clientId, clientSecret, privateKey };
}

export function isGitHubAppConfigured(): boolean {
  return githubAppConfig() !== null;
}

/** Where the customer installs the app (choosing which repos). `state` round-trips to our callback. */
export function installUrl(cfg: Pick<GitHubAppConfig, "slug">, state: string): string {
  const u = new URL(`https://github.com/apps/${cfg.slug}/installations/new`);
  u.searchParams.set("state", state);
  return u.toString();
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The app's own short-lived JWT (RS256, ≤10 min) for calling GitHub as the app. */
export function appJwt(cfg: Pick<GitHubAppConfig, "appId" | "privateKey">, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60 s for clock drift, per GitHub's guidance; exp well under the 10-minute max.
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: cfg.appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

type Fetch = typeof fetch;

/** A one-hour token for ONE installation, down-scoped to reading contents. */
export async function mintInstallationToken(
  installationId: number,
  cfg: Pick<GitHubAppConfig, "appId" | "privateKey">,
  fetchImpl: Fetch = fetch,
): Promise<{ token: string; expiresAt: string }> {
  const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...API_HEADERS, Authorization: `Bearer ${appJwt(cfg)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ permissions: { contents: "read", metadata: "read" } }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string };
  if (!res.ok || !data.token) throw new Error(`github_app_token_failed:${res.status}`);
  return { token: data.token, expiresAt: data.expires_at ?? "" };
}

const WRITE_LEVELS = new Set(["write", "admin"]);

/**
 * Confirm `installationId` belongs to the user who just authorised, and that it
 * grants nothing beyond reading. Returns the account it's installed on.
 */
export async function verifyUserInstallation(
  input: { code: string; installationId: number; redirectUri: string },
  cfg: Pick<GitHubAppConfig, "clientId" | "clientSecret">,
  fetchImpl: Fetch = fetch,
): Promise<{ ok: true; accountLogin: string | null; repositorySelection: string | null } | { ok: false; reason: string }> {
  const tokRes = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tok = (await tokRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokRes.ok || !tok.access_token) return { ok: false, reason: "token_exchange_failed" };

  // The user token only proves who's connecting; it's never stored.
  const res = await fetchImpl(`${API}/user/installations?per_page=100`, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    installations?: Array<{ id: number; account?: { login?: string } | null; permissions?: Record<string, string>; repository_selection?: string }>;
  };
  if (!res.ok) return { ok: false, reason: "installations_lookup_failed" };
  const inst = (data.installations ?? []).find((i) => i.id === input.installationId);
  if (!inst) return { ok: false, reason: "installation_not_yours" };
  const perms = inst.permissions ?? {};
  if (Object.values(perms).some((level) => WRITE_LEVELS.has(level))) return { ok: false, reason: "app_not_read_only" };
  return { ok: true, accountLogin: inst.account?.login ?? null, repositorySelection: inst.repository_selection ?? null };
}
