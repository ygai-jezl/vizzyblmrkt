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
 *
 * With linking on (GITHUB_APP_LINK_ENABLED), Connect starts at GitHub's authorize
 * page instead, so an app ALREADY installed on the customer's account or org can
 * be linked — GitHub's install page only offers "Configure" for those, which
 * never returns a code.
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

/** Connect links existing installs (authorize first) and manage links open the install's own page. */
export function isGitHubAppLinkEnabled(): boolean {
  return process.env.GITHUB_APP_LINK_ENABLED === "true";
}

/** Where the customer installs the app (choosing which repos). `state` round-trips to our callback. */
export function installUrl(cfg: Pick<GitHubAppConfig, "slug">, state: string): string {
  const u = new URL(`https://github.com/apps/${cfg.slug}/installations/new`);
  u.searchParams.set("state", state);
  return u.toString();
}

/**
 * GitHub's "Authorize YouGrow" page. It only proves who's connecting — the app's
 * permissions stay read-only — and returns a code we use to list the installs
 * this person can use. GitHub skips the prompt for someone who already authorised.
 */
export function authorizeUrl(cfg: Pick<GitHubAppConfig, "clientId">, redirectUri: string, state: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
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

export type GitHubAccountType = "User" | "Organization";

const accountType = (t: unknown): GitHubAccountType | null => (t === "User" || t === "Organization" ? t : null);

/** One install of this app that the signed-in GitHub user can access. */
export interface UserInstallation {
  installationId: number;
  accountLogin: string | null;
  accountType: GitHubAccountType | null;
  repositorySelection: string | null;
  /** false if the install grants anything beyond reading — we refuse those. */
  readOnly: boolean;
}

/**
 * Exchange the one-time code for a user token and list the installs of this app
 * that user can access. The token only proves who's connecting; it's never stored.
 */
export async function listUserInstallations(
  input: { code: string; redirectUri: string },
  cfg: Pick<GitHubAppConfig, "clientId" | "clientSecret">,
  fetchImpl: Fetch = fetch,
): Promise<{ ok: true; installations: UserInstallation[] } | { ok: false; reason: string }> {
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
    installations?: Array<{
      id?: number;
      account?: { login?: string; type?: string } | null;
      permissions?: Record<string, string>;
      repository_selection?: string;
    }>;
  };
  if (!res.ok) return { ok: false, reason: "installations_lookup_failed" };
  const installations: UserInstallation[] = [];
  for (const i of data.installations ?? []) {
    if (typeof i.id !== "number" || !Number.isInteger(i.id) || i.id <= 0) continue;
    installations.push({
      installationId: i.id,
      accountLogin: typeof i.account?.login === "string" ? i.account.login : null,
      accountType: accountType(i.account?.type),
      repositorySelection: i.repository_selection ?? null,
      readOnly: !Object.values(i.permissions ?? {}).some((level) => WRITE_LEVELS.has(level)),
    });
  }
  return { ok: true, installations };
}

/**
 * Confirm `installationId` belongs to the user who just authorised, and that it
 * grants nothing beyond reading. Returns the account it's installed on.
 */
export async function verifyUserInstallation(
  input: { code: string; installationId: number; redirectUri: string },
  cfg: Pick<GitHubAppConfig, "clientId" | "clientSecret">,
  fetchImpl: Fetch = fetch,
): Promise<
  | { ok: true; accountLogin: string | null; accountType: GitHubAccountType | null; repositorySelection: string | null }
  | { ok: false; reason: string }
> {
  const r = await listUserInstallations(input, cfg, fetchImpl);
  if (!r.ok) return r;
  const inst = r.installations.find((i) => i.installationId === input.installationId);
  if (!inst) return { ok: false, reason: "installation_not_yours" };
  if (!inst.readOnly) return { ok: false, reason: "app_not_read_only" };
  return { ok: true, accountLogin: inst.accountLogin, accountType: inst.accountType, repositorySelection: inst.repositorySelection };
}

/** Where a customer adds or removes repositories (GitHub lists their installs with "Configure"). */
export function manageInstallationUrl(cfg: Pick<GitHubAppConfig, "slug">): string {
  return `https://github.com/apps/${cfg.slug}/installations/new`;
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The install's own settings page on GitHub, where its repositories are changed.
 * Unlike the app page, it can't start a new install on another account by mistake.
 * null when we don't know which kind of account it's on.
 */
export function installationSettingsUrl(i: {
  installationId: number;
  accountLogin?: string | null;
  accountType?: GitHubAccountType | null;
}): string | null {
  if (!Number.isInteger(i.installationId) || i.installationId <= 0) return null;
  if (i.accountType === "User") return `https://github.com/settings/installations/${i.installationId}`;
  if (i.accountType === "Organization" && i.accountLogin && GITHUB_LOGIN.test(i.accountLogin)) {
    return `https://github.com/organizations/${i.accountLogin}/settings/installations/${i.installationId}`;
  }
  return null;
}

/** Which account an install is on, asked as the app (for connections saved before we kept its type). */
export async function getInstallationAccount(
  installationId: number,
  cfg: Pick<GitHubAppConfig, "appId" | "privateKey">,
  fetchImpl: Fetch = fetch,
): Promise<{ accountLogin: string | null; accountType: GitHubAccountType | null } | null> {
  const res = await fetchImpl(`${API}/app/installations/${installationId}`, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${appJwt(cfg)}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const d = (await res.json().catch(() => ({}))) as { account?: { login?: string; type?: string } | null };
  return { accountLogin: typeof d.account?.login === "string" ? d.account.login : null, accountType: accountType(d.account?.type) };
}

/**
 * Where a connection's repositories are changed: the install's own page when
 * linking is on and we know its account, else GitHub's page for the app.
 */
export async function manageUrlFor(
  conn: { installationId?: number; accountLogin?: string; accountType?: GitHubAccountType },
  cfg: GitHubAppConfig,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const fallback = manageInstallationUrl(cfg);
  if (!isGitHubAppLinkEnabled() || !conn.installationId) return fallback;
  const account = conn.accountType
    ? { accountLogin: conn.accountLogin ?? null, accountType: conn.accountType }
    : await getInstallationAccount(conn.installationId, cfg, fetchImpl).catch(() => null);
  return (account && installationSettingsUrl({ installationId: conn.installationId, ...account })) ?? fallback;
}

export interface InstallationRepo {
  /** owner/name */
  fullName: string;
  url: string;
  defaultBranch: string | null;
  private: boolean;
}

const MAX_REPO_PAGES = 5;

/** The repositories this installation can read — exactly what the customer chose on GitHub. */
export async function listInstallationRepos(
  installationId: number,
  cfg: Pick<GitHubAppConfig, "appId" | "privateKey">,
  fetchImpl: Fetch = fetch,
): Promise<{ repos: InstallationRepo[]; truncated: boolean }> {
  const { token } = await mintInstallationToken(installationId, cfg, fetchImpl);
  const repos: InstallationRepo[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const res = await fetchImpl(`${API}/installation/repositories?per_page=100&page=${page}`, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`github_app_repos_failed:${res.status}`);
    const data = (await res.json().catch(() => ({}))) as {
      total_count?: number;
      repositories?: Array<{ full_name?: string; html_url?: string; default_branch?: string; private?: boolean }>;
    };
    for (const r of data.repositories ?? []) {
      if (typeof r.full_name === "string" && typeof r.html_url === "string" && r.html_url.startsWith("https://github.com/")) {
        repos.push({ fullName: r.full_name, url: r.html_url, defaultBranch: r.default_branch ?? null, private: Boolean(r.private) });
      }
    }
    if ((data.repositories ?? []).length < 100) break;
    if (page === MAX_REPO_PAGES) truncated = (data.total_count ?? 0) > repos.length;
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { repos, truncated };
}
