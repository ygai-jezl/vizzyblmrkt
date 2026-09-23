import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { appJwt, githubAppConfig, installUrl, listInstallationRepos, manageInstallationUrl, mintInstallationToken, verifyUserInstallation } from "./githubApp";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const cfg = { appId: "12345", slug: "yougrow-connect", clientId: "Iv1.test", clientSecret: "test-only-secret", privateKey: pem };

type Call = { url: string; init?: RequestInit };
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("GitHub App (read-only)", () => {
  it("is configured only with every value present and well-formed", () => {
    const env = { GITHUB_APP_ID: "12345", GITHUB_APP_SLUG: "yougrow-connect", GITHUB_APP_CLIENT_ID: "Iv1.x", GITHUB_APP_CLIENT_SECRET: "s", GITHUB_APP_PRIVATE_KEY: pem };
    expect(githubAppConfig(env)).not.toBeNull();
    expect(githubAppConfig({ ...env, GITHUB_APP_PRIVATE_KEY: "" })).toBeNull();
    expect(githubAppConfig({ ...env, GITHUB_APP_ID: "abc" })).toBeNull();
  });

  it("sends people to install the app, carrying the signed state", () => {
    expect(installUrl(cfg, "st.ate")).toBe("https://github.com/apps/yougrow-connect/installations/new?state=st.ate");
  });

  it("signs a short-lived app JWT that verifies with the app's public key", () => {
    const jwt = appJwt(cfg, 1_758_600_000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 1_758_599_940, exp: 1_758_600_540, iss: "12345" });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("mints installation tokens down-scoped to reading contents", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, body: { token: "ghs_x", expires_at: "2026-09-23T01:00:00Z" } }));
    expect(await mintInstallationToken(77, cfg, f)).toEqual({ token: "ghs_x", expiresAt: "2026-09-23T01:00:00Z" });
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ permissions: { contents: "read", metadata: "read" } });
  });

  it("accepts an installation only if it's the user's and grants nothing beyond reading", async () => {
    const installs = (perms: Record<string, string>) =>
      fakeFetch((url) =>
        url.includes("login/oauth")
          ? { status: 200, body: { access_token: "ghu_user" } }
          : { status: 200, body: { installations: [{ id: 77, account: { login: "acme" }, permissions: perms, repository_selection: "selected" }] } },
      );
    const input = { code: "c", installationId: 77, redirectUri: "https://yougrow.test/cb" };

    const ok = installs({ contents: "read", metadata: "read" });
    expect(await verifyUserInstallation(input, cfg, ok.f)).toEqual({ ok: true, accountLogin: "acme", repositorySelection: "selected" });
    expect(ok.calls[1]!.url).toContain("/user/installations");

    expect(await verifyUserInstallation({ ...input, installationId: 99 }, cfg, installs({ contents: "read" }).f)).toEqual({ ok: false, reason: "installation_not_yours" });
    expect(await verifyUserInstallation(input, cfg, installs({ contents: "write" }).f)).toEqual({ ok: false, reason: "app_not_read_only" });
  });

  it("lists exactly the repositories the customer chose, with a read-only token", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.endsWith("/access_tokens")
        ? { status: 201, body: { token: "ghs_x" } }
        : {
            status: 200,
            body: {
              total_count: 2,
              repositories: [
                { full_name: "vizzybl-ai/vizzybl", html_url: "https://github.com/vizzybl-ai/vizzybl", default_branch: "main", private: true },
                { full_name: "vizzybl-ai/docs", html_url: "https://github.com/vizzybl-ai/docs", default_branch: "main", private: false },
                { full_name: "evil/x", html_url: "https://evil.example/x" },
              ],
            },
          },
    );
    const r = await listInstallationRepos(77, cfg, f);
    expect(r).toEqual({
      truncated: false,
      repos: [
        { fullName: "vizzybl-ai/docs", url: "https://github.com/vizzybl-ai/docs", defaultBranch: "main", private: false },
        { fullName: "vizzybl-ai/vizzybl", url: "https://github.com/vizzybl-ai/vizzybl", defaultBranch: "main", private: true },
      ],
    });
    expect(calls[1]!.url).toContain("/installation/repositories");
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer ghs_x");
  });

  it("links to GitHub's own page for adding or removing repositories", () => {
    expect(manageInstallationUrl(cfg)).toBe("https://github.com/apps/yougrow-connect/installations/new");
  });
});

