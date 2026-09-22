/**
 * Repository selection for a tenant's GitHub/GitLab connection. One OAuth token
 * can see every repo across the user's personal account AND every org/group they
 * belong to; the admin picks WHICH of those we may use, and only those are stored
 * on the connection (`GitConnection.repos`). The knowledge-scraper worker only
 * attaches the token when cloning a selected repo (see
 * workers/knowledge-scraper/src/gitToken.ts — keep `repoPathFromUrl` in sync).
 *
 * `repos` semantics: undefined = legacy connection made before selection existed
 * (token used for any repo); [] = connected but nothing chosen yet (token unused).
 *
 * Flag-gated: GIT_REPO_SELECTION_ENABLED (server-only).
 */
import type { GitProvider } from "./providers";

export const MAX_SELECTED_REPOS = 200;
/** 100 per page × 10 pages — enough for any real admin, bounded for the request. */
const MAX_LIST_PAGES = 10;

export function isGitRepoSelectionEnabled(): boolean {
  return process.env.GIT_REPO_SELECTION_ENABLED === "true";
}

export interface GitRepoSummary {
  /** Lowercased repo path, e.g. `acme/app` or `group/sub/project` (GitLab). */
  fullPath: string;
  /** The personal account, org or (top-level) group that owns it. */
  owner: string;
  ownerKind: "user" | "org" | "group";
  name: string;
  private: boolean;
  defaultBranch: string | null;
  /** Clone/browse URL (https, the provider's canonical casing). */
  webUrl: string;
}

/**
 * Normalized repo path from a repo URL, or null when it isn't a repo root URL on
 * the provider's host. Lowercased, no `.git`, no trailing slash. GitLab paths may
 * nest groups; anything after a `/-/` (tree/blob views) is dropped.
 */
export function repoPathFromUrl(provider: GitProvider, raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== (provider === "github" ? "github.com" : "gitlab.com")) return null;
  let path = u.pathname.split("/-/")[0] ?? "";
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
  const parts = path.split("/").filter(Boolean);
  if (provider === "github" ? parts.length !== 2 : parts.length < 2) return null;
  return parts.join("/");
}

/** True when the connection allows its token for this repo URL. */
export function isRepoSelected(
  provider: GitProvider,
  repos: { fullPath: string }[] | undefined,
  repoUrl: string,
): boolean {
  if (repos === undefined) return true;
  const path = repoPathFromUrl(provider, repoUrl);
  return path !== null && repos.some((r) => r.fullPath === path);
}

/** GitHub page where the user grants the OAuth app access to an org that restricts
 *  third-party apps (those orgs' private repos are otherwise invisible to us). */
export function githubOrgAccessUrl(clientId: string): string {
  return `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`;
}

export class RepoListError extends Error {
  constructor(
    public readonly code: "reconnect_required" | "provider_error",
    public readonly status?: number,
  ) {
    super(code);
  }
}

type FetchLike = typeof fetch;

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  token: string,
): Promise<unknown[]> {
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "Vizzybl-Knowledge",
    },
  });
  const rateLimited = res.headers.get("x-ratelimit-remaining") === "0";
  if ((res.status === 401 || res.status === 403) && !rateLimited) {
    throw new RepoListError("reconnect_required", res.status);
  }
  if (!res.ok) throw new RepoListError("provider_error", res.status);
  const body = await res.json().catch(() => null);
  return Array.isArray(body) ? body : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function fromGithub(r: Record<string, unknown>): GitRepoSummary | null {
  const fullName = str(r.full_name);
  const htmlUrl = str(r.html_url);
  const owner = (r.owner ?? {}) as Record<string, unknown>;
  const login = str(owner.login);
  if (!fullName || !htmlUrl || !login) return null;
  return {
    fullPath: fullName.toLowerCase(),
    owner: login,
    ownerKind: owner.type === "Organization" ? "org" : "user",
    name: str(r.name) ?? fullName.split("/")[1] ?? fullName,
    private: r.private === true,
    defaultBranch: str(r.default_branch),
    webUrl: htmlUrl,
  };
}

function fromGitlab(r: Record<string, unknown>): GitRepoSummary | null {
  const path = str(r.path_with_namespace);
  const webUrl = str(r.web_url);
  const ns = (r.namespace ?? {}) as Record<string, unknown>;
  if (!path || !webUrl) return null;
  const nsPath = str(ns.full_path) ?? path.split("/").slice(0, -1).join("/");
  return {
    fullPath: path.toLowerCase(),
    owner: nsPath.split("/")[0] ?? nsPath,
    ownerKind: ns.kind === "user" ? "user" : "group",
    name: str(r.name) ?? path.split("/").pop()!,
    private: r.visibility !== "public",
    defaultBranch: str(r.default_branch),
    webUrl,
  };
}

/**
 * Every repo the token can read — the user's own plus every org/group they're a
 * member of — sorted by owner then path. `truncated` when the page cap was hit.
 */
export async function listAccessibleRepos(
  provider: GitProvider,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ repos: GitRepoSummary[]; truncated: boolean }> {
  const out = new Map<string, GitRepoSummary>();
  let truncated = false;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const url =
      provider === "github"
        ? `https://api.github.com/user/repos?per_page=100&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`
        : `https://gitlab.com/api/v4/projects?membership=true&per_page=100&page=${page}&order_by=path&sort=asc`;
    const rows = await getJson(fetchImpl, url, token);
    for (const row of rows) {
      const r = (provider === "github" ? fromGithub : fromGitlab)(row as Record<string, unknown>);
      if (r) out.set(r.fullPath, r);
    }
    if (rows.length < 100) break;
    if (page === MAX_LIST_PAGES) truncated = true;
  }
  const repos = [...out.values()].sort(
    (a, b) => a.owner.localeCompare(b.owner) || a.fullPath.localeCompare(b.fullPath),
  );
  return { repos, truncated };
}
