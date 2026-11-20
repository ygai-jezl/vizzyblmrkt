import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitConnection } from "@/lib/types/tenant";
import { encryptToken, gitRefreshAad } from "./crypto";
import { REVOKE_TIMEOUT_MS, revokeGitConnection, revokeReplacedGitConnection } from "./revoke";

// Revoking a git token at the provider: GitLab's revoke endpoint, the classic GitHub
// single-token endpoint (never /grant), and never a GitHub App uninstall. Best effort:
// it never throws, gives up after 8 seconds and never logs a token.
const gitlab = (over: Partial<GitConnection> = {}): GitConnection => ({
  provider: "gitlab",
  kind: "oauth",
  enc: encryptToken("gl-access"),
  refreshEnc: encryptToken("gl-refresh", gitRefreshAad("ten_A", "gitlab")),
  expiresAt: "2026-11-20T12:00:00.000Z",
  connectedAt: "2026-11-20T10:00:00.000Z",
  ...over,
});
const github = (over: Partial<GitConnection> = {}): GitConnection => ({
  provider: "github",
  kind: "oauth",
  enc: encryptToken("gho_classic"),
  connectedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});
const githubApp = (): GitConnection => ({
  provider: "github",
  kind: "app",
  installationId: 222,
  connectedAt: "2026-11-01T00:00:00.000Z",
});

let fetchMock: ReturnType<typeof vi.fn>;
const deps = () => ({ fetch: fetchMock as unknown as typeof fetch });
const sent = () => fetchMock.mock.calls[0] as [string, RequestInit];
let warn: ReturnType<typeof vi.spyOn>;
const logged = () => warn.mock.calls.map((c) => c.join(" ")).join("\n");

beforeEach(() => {
  vi.stubEnv("GIT_TOKEN_ENC_KEY", "unit-test-root-key-please-rotate");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-test-client");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-test-secret");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "github-test-client");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "github-test-secret");
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe("revokeGitConnection: GitLab", () => {
  it("posts the refresh token to GitLab's revoke endpoint with the client credentials", async () => {
    expect(await revokeGitConnection("ten_A", gitlab(), deps())).toEqual({ result: "done" });
    const [url, init] = sent();
    expect(url).toBe("https://gitlab.com/oauth/revoke");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      client_id: "gitlab-test-client",
      client_secret: "gitlab-test-secret",
      token: "gl-refresh",
      token_type_hint: "refresh_token",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the access token for an older connection with no refresh token", async () => {
    await revokeGitConnection("ten_A", gitlab({ refreshEnc: null }), deps());
    const body = Object.fromEntries(new URLSearchParams(String(sent()[1].body)));
    expect(body).toMatchObject({ token: "gl-access", token_type_hint: "access_token" });
  });

  it("skips a refresh token sealed for another brand, with no call", async () => {
    const conn = gitlab({ refreshEnc: encryptToken("gl-refresh", gitRefreshAad("ten_B", "gitlab")) });
    expect(await revokeGitConnection("ten_A", conn, deps())).toEqual({ result: "skipped", reason: "unreadable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when GitLab isn't set up on this YouGrow", async () => {
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "");
    expect(await revokeGitConnection("ten_A", gitlab(), deps())).toEqual({ result: "skipped", reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revokeGitConnection: classic GitHub", () => {
  it("deletes that one token with Basic client auth, never the whole grant", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await revokeGitConnection("ten_A", github(), deps())).toEqual({ result: "done" });
    const [url, init] = sent();
    expect(url).toBe("https://api.github.com/applications/github-test-client/token");
    expect(url).not.toContain("/grant");
    expect(init.method).toBe("DELETE");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("github-test-client:github-test-secret").toString("base64")}`);
    expect(JSON.parse(String(init.body))).toEqual({ access_token: "gho_classic" });
  });

  it("an older connection with no kind is classic too", async () => {
    const conn = github();
    delete conn.kind;
    await revokeGitConnection("ten_A", conn, deps());
    expect(sent()[0]).toBe("https://api.github.com/applications/github-test-client/token");
  });

  it("skips when the classic GitHub app isn't set up", async () => {
    vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "");
    expect(await revokeGitConnection("ten_A", github(), deps())).toEqual({ result: "skipped", reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revokeGitConnection: skipped without a call", () => {
  // Built inside each test: encrypting needs the key stubbed in beforeEach.
  it.each([
    ["a GitHub App installation, which is never uninstalled", () => githubApp(), "github_app"],
    ["no connection", () => null, "not_connected"],
    ["a connection with no token", () => github({ enc: undefined }), "no_token"],
    ["a token that won't open", () => github({ enc: { ct: "x", iv: "x", tag: "x" } }), "unreadable"],
  ])("%s", async (_label, conn: () => GitConnection | null, reason) => {
    expect(await revokeGitConnection("ten_A", conn(), deps())).toEqual({ result: "skipped", reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revokeGitConnection: failures never throw", () => {
  it("a refused revoke is failed, with the status and no token in the log", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await revokeGitConnection("ten_A", gitlab(), deps())).toEqual({ result: "failed", reason: "api_401" });
    expect(logged()).toContain("[revoke] gitlab revoke failed for ten_A: api_401");
    expect(logged()).not.toMatch(/gl-refresh|gl-access|gitlab-test-secret/);
  });

  it("a network error is failed", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed gl-refresh"));
    expect(await revokeGitConnection("ten_A", github(), deps())).toEqual({ result: "failed", reason: "network:TypeError" });
    expect(logged()).not.toMatch(/gl-refresh|gho_classic/);
  });

  it("gives up after the timeout", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const res = await revokeGitConnection("ten_A", gitlab(), { ...deps(), timeoutMs: 5 });
    expect(res).toEqual({ result: "failed", reason: "timeout" });
  });

  it("waits 8 seconds by default", () => {
    expect(REVOKE_TIMEOUT_MS).toBe(8_000);
  });

  it("a fetch that throws straight away is failed", async () => {
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await revokeGitConnection("ten_A", gitlab(), { fetch: throwing })).toEqual({
      result: "failed",
      reason: "network:Error",
    });
  });
});

describe("revokeReplacedGitConnection", () => {
  it("revokes the old token when a reconnect brings a different one", async () => {
    const res = await revokeReplacedGitConnection("ten_A", gitlab(), { accessToken: "gl-new", refreshToken: "gl-new-refresh" }, deps());
    expect(res).toEqual({ result: "done" });
    expect(Object.fromEntries(new URLSearchParams(String(sent()[1].body))).token).toBe("gl-refresh");
  });

  it("never revokes when the provider handed back the same access token", async () => {
    const res = await revokeReplacedGitConnection("ten_A", github(), { accessToken: "gho_classic", refreshToken: null }, deps());
    expect(res).toEqual({ result: "skipped", reason: "same_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never revokes when the provider handed back the same refresh token", async () => {
    const res = await revokeReplacedGitConnection("ten_A", gitlab(), { accessToken: "gl-new", refreshToken: "gl-refresh" }, deps());
    expect(res).toEqual({ result: "skipped", reason: "same_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes an older GitHub token replaced by the GitHub App", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await revokeReplacedGitConnection("ten_A", github(), { accessToken: null, refreshToken: null }, deps());
    expect(res).toEqual({ result: "done" });
    expect(sent()[0]).toBe("https://api.github.com/applications/github-test-client/token");
  });

  it("skips a first connect and a reinstalled GitHub App", async () => {
    expect(await revokeReplacedGitConnection("ten_A", undefined, { accessToken: "x", refreshToken: null }, deps())).toMatchObject({
      result: "skipped",
    });
    expect(await revokeReplacedGitConnection("ten_A", githubApp(), { accessToken: null, refreshToken: null }, deps())).toEqual({
      result: "skipped",
      reason: "github_app",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
