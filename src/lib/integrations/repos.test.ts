import { describe, it, expect } from "vitest";
import { isRepoSelected, listAccessibleRepos, repoPathFromUrl, RepoListError } from "./repos";
import { authorizeScope } from "./providers";

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("repoPathFromUrl", () => {
  it("normalizes GitHub repo URLs", () => {
    expect(repoPathFromUrl("github", "https://github.com/Acme/App")).toBe("acme/app");
    expect(repoPathFromUrl("github", "https://www.github.com/acme/app.git/")).toBe("acme/app");
    expect(repoPathFromUrl("github", "https://github.com/acme")).toBeNull();
    expect(repoPathFromUrl("github", "https://github.com/acme/app/tree/main")).toBeNull();
    expect(repoPathFromUrl("github", "https://gitlab.com/acme/app")).toBeNull();
  });

  it("keeps nested GitLab groups and drops /-/ views", () => {
    expect(repoPathFromUrl("gitlab", "https://gitlab.com/Grp/Sub/Proj")).toBe("grp/sub/proj");
    expect(repoPathFromUrl("gitlab", "https://gitlab.com/grp/proj/-/tree/main")).toBe("grp/proj");
    expect(repoPathFromUrl("gitlab", "not a url")).toBeNull();
  });
});

describe("isRepoSelected", () => {
  it("allows any repo on a legacy connection (no selection)", () => {
    expect(isRepoSelected("github", undefined, "https://github.com/a/b")).toBe(true);
  });
  it("allows only selected repos once a selection exists", () => {
    const repos = [{ fullPath: "acme/app" }];
    expect(isRepoSelected("github", repos, "https://github.com/Acme/App.git")).toBe(true);
    expect(isRepoSelected("github", repos, "https://github.com/acme/other")).toBe(false);
    expect(isRepoSelected("github", [], "https://github.com/acme/app")).toBe(false);
  });
});

describe("listAccessibleRepos", () => {
  it("lists GitHub repos across personal account and orgs, paginated", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      full_name: `Org1/r${String(i).padStart(3, "0")}`,
      name: `r${i}`,
      html_url: `https://github.com/Org1/r${i}`,
      private: true,
      default_branch: "main",
      owner: { login: "Org1", type: "Organization" },
    }));
    const page2 = [
      {
        full_name: "me/dotfiles",
        name: "dotfiles",
        html_url: "https://github.com/me/dotfiles",
        private: false,
        owner: { login: "me", type: "User" },
      },
    ];
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return jsonRes(url.includes("page=1&") ? page1 : page2);
    }) as unknown as typeof fetch;

    const { repos, truncated } = await listAccessibleRepos("github", "t", fetchImpl);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("affiliation=owner,collaborator,organization_member");
    expect(truncated).toBe(false);
    expect(repos).toHaveLength(101);
    const mine = repos.find((r) => r.fullPath === "me/dotfiles")!;
    expect(mine).toMatchObject({ owner: "me", ownerKind: "user", private: false });
    expect(repos.find((r) => r.owner === "Org1")?.ownerKind).toBe("org");
  });

  it("maps GitLab projects with nested groups", async () => {
    const fetchImpl = (async () =>
      jsonRes([
        {
          path_with_namespace: "Grp/Sub/Proj",
          name: "Proj",
          web_url: "https://gitlab.com/Grp/Sub/Proj",
          visibility: "private",
          default_branch: "main",
          namespace: { full_path: "Grp/Sub", kind: "group" },
        },
      ])) as unknown as typeof fetch;
    const { repos } = await listAccessibleRepos("gitlab", "t", fetchImpl);
    expect(repos[0]).toMatchObject({
      fullPath: "grp/sub/proj",
      owner: "Grp",
      ownerKind: "group",
      private: true,
    });
  });

  it("asks for a reconnect on 401/403 but not on a rate limit", async () => {
    const denied = (async () => jsonRes({}, 403)) as unknown as typeof fetch;
    await expect(listAccessibleRepos("gitlab", "t", denied)).rejects.toMatchObject({
      code: "reconnect_required",
    });
    const limited = (async () =>
      jsonRes({}, 403, { "x-ratelimit-remaining": "0" })) as unknown as typeof fetch;
    const err = await listAccessibleRepos("github", "t", limited).catch((e) => e);
    expect(err).toBeInstanceOf(RepoListError);
    expect(err.code).toBe("provider_error");
  });
});

describe("authorizeScope", () => {
  it("adds GitLab's listing scope only when repo selection is on", () => {
    expect(authorizeScope("gitlab", false)).toBe("read_repository read_user");
    expect(authorizeScope("gitlab", true)).toBe("read_repository read_user read_api");
    expect(authorizeScope("github", true)).toBe("repo");
  });
});
