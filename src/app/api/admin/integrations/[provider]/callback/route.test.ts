import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The GitHub and GitLab callback only finishes a connection in the browser that started
// it: the signed state's nonce must match the git_oauth_state cookie, checked before any
// code is exchanged. Every redirect back to Connections clears the cookie.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ getTenantById: vi.fn(), setTenantGitConnection: vi.fn() }));
vi.mock("@/lib/tenant", () => tenant);
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  })),
}));

const { GET } = await import("./route");
const { signState, decryptToken, gitRefreshAad } = await import("@/lib/integrations/crypto");

const ORIGIN = "https://yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const member = { ...admin, userId: "u2", role: "member" };
const APP_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "yougrow-test",
  GITHUB_APP_CLIENT_ID: "Iv1.test",
  GITHUB_APP_CLIENT_SECRET: "test-only-secret",
  GITHUB_APP_PRIVATE_KEY: "test-only-key",
};
const call = (provider: "github" | "gitlab", query: Record<string, string>) =>
  GET(new Request(`${ORIGIN}/api/admin/integrations/${provider}/callback?${new URLSearchParams(query)}`), {
    params: Promise.resolve({ provider }),
  });
const location = (res: Response) => new URL(res.headers.get("location") ?? "");
const stateFor = (provider: "github" | "gitlab", n = "nonce-1", t = "ten_A") =>
  signState({ t, p: provider, n, ts: Date.now() });
/** The redirect clears the provider's cookie (an expired Set-Cookie on its callback path). */
const clearsCookie = (res: Response, provider: "github" | "gitlab") => {
  const raw = res.headers.get("set-cookie") ?? "";
  expect(raw).toContain("git_oauth_state=;");
  expect(raw).toContain(`Path=/api/admin/integrations/${provider}/callback`);
};

type Install = { id: number; account: { login: string; type: string }; permissions: Record<string, string>; repository_selection: string };
let installs: Install[] = [];
const fetchMock = vi.fn(async (url: string) => {
  const u = String(url);
  if (u.includes("login/oauth/access_token")) return new Response(JSON.stringify({ access_token: "ghu_user" }), { status: 200 });
  if (u.includes("/user/installations")) return new Response(JSON.stringify({ installations: installs }), { status: 200 });
  if (u.includes("gitlab.com/oauth/token")) {
    return new Response(
      JSON.stringify({
        access_token: "gl-test-token",
        refresh_token: "gl-test-refresh",
        expires_in: 7200,
        scope: "read_repository read_user",
      }),
      { status: 200 },
    );
  }
  if (u.includes("gitlab.com/api/v4/user")) return new Response(JSON.stringify({ username: "acme-dev" }), { status: 200 });
  return new Response("{}", { status: 404 });
});
const org = (id: number): Install => ({
  id,
  account: { login: "acme-org", type: "Organization" },
  permissions: { contents: "read", metadata: "read" },
  repository_selection: "selected",
});

beforeEach(() => {
  vi.clearAllMocks();
  jar.clear();
  vi.stubEnv("GIT_TOKEN_ENC_KEY", "unit-test-root-key-please-rotate");
  vi.stubEnv("GIT_OAUTH_ORIGIN", ORIGIN);
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-test-client");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-test-secret");
  vi.stubEnv("GIT_REPO_SELECTION_ENABLED", "");
  for (const [k, v] of Object.entries(APP_ENV)) vi.stubEnv(k, v);
  session.getAdminContext.mockResolvedValue(admin);
  tenant.getTenantById.mockResolvedValue({ gitConnections: {} });
  installs = [org(222)];
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GitLab callback: the nonce cookie", () => {
  it("a missing cookie is bad_state, with no exchange and nothing saved", async () => {
    const res = await call("gitlab", { code: "c", state: stateFor("gitlab") });
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ status: "error", reason: "bad_state", provider: "gitlab" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
    clearsCookie(res, "gitlab");
  });

  it("a cookie from another flow is bad_state", async () => {
    jar.set("git_oauth_state", "nonce-other");
    const res = await call("gitlab", { code: "c", state: stateFor("gitlab", "nonce-1") });
    expect(location(res).searchParams.get("reason")).toBe("bad_state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  });

  it("another brand's state is bad_state, even with its matching cookie", async () => {
    jar.set("git_oauth_state", "nonce-1");
    const res = await call("gitlab", { code: "c", state: stateFor("gitlab", "nonce-1", "ten_B") });
    expect(location(res).searchParams.get("reason")).toBe("bad_state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  });

  it("the browser that started connects, and the cookie is cleared", async () => {
    jar.set("git_oauth_state", "nonce-1");
    const res = await call("gitlab", { code: "c", state: stateFor("gitlab", "nonce-1") });
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ status: "ok", provider: "gitlab" });
    expect(tenant.setTenantGitConnection).toHaveBeenCalledWith(
      "ten_A",
      "gitlab",
      expect.objectContaining({ kind: "oauth", accountLogin: "acme-dev" }),
    );
    clearsCookie(res, "gitlab");
  });
});

describe("GitLab callback: the refresh token", () => {
  const saved = () => tenant.setTenantGitConnection.mock.calls[0]?.[2] as Record<string, unknown>;

  it("stores the refresh token sealed to this brand, and the expiry 2 hours ahead", async () => {
    jar.set("git_oauth_state", "nonce-1");
    const before = Date.now();
    const res = await call("gitlab", { code: "c", state: stateFor("gitlab") });
    const after = Date.now();
    expect(location(res).searchParams.get("status")).toBe("ok");
    const conn = saved();
    const refreshEnc = conn.refreshEnc as { ct: string; iv: string; tag: string };
    expect(refreshEnc.ct).not.toContain("gl-test-refresh");
    expect(decryptToken(refreshEnc, gitRefreshAad("ten_A", "gitlab"))).toBe("gl-test-refresh");
    expect(() => decryptToken(refreshEnc, gitRefreshAad("ten_B", "gitlab"))).toThrow();
    expect(() => decryptToken(refreshEnc)).toThrow();
    // The access token keeps no AAD: the worker opens it.
    expect(decryptToken(conn.enc as { ct: string; iv: string; tag: string })).toBe("gl-test-token");
    const expires = Date.parse(conn.expiresAt as string);
    expect(expires).toBeGreaterThanOrEqual(before + 7200 * 1000);
    expect(expires).toBeLessThanOrEqual(after + 7200 * 1000);
    expect(conn).not.toHaveProperty("reconnect");
  });

  it("stores null when GitLab sends no refresh token or expiry", async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ access_token: "gl-test-token", scope: "read_repository read_user" }), { status: 200 }),
    );
    jar.set("git_oauth_state", "nonce-1");
    await call("gitlab", { code: "c", state: stateFor("gitlab") });
    expect(saved()).toMatchObject({ refreshEnc: null, expiresAt: null });
  });

  it("a reconnect keeps the chosen repos", async () => {
    vi.stubEnv("GIT_REPO_SELECTION_ENABLED", "true");
    const repos = [{ fullPath: "acme/app", owner: "acme", private: true, defaultBranch: "main", webUrl: "https://gitlab.com/acme/app" }];
    tenant.getTenantById.mockResolvedValue({
      gitConnections: { gitlab: { provider: "gitlab", kind: "oauth", connectedAt: "2026-01-01T00:00:00.000Z", repos, reconnect: { at: "x", reason: "refresh_failed" } } },
    });
    jar.set("git_oauth_state", "nonce-1");
    const res = await call("gitlab", { code: "c", state: stateFor("gitlab") });
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ status: "ok", provider: "gitlab" });
    expect(saved()).toMatchObject({ repos });
    expect(saved()).not.toHaveProperty("reconnect");
  });
});

describe("classic GitHub callback (no GitHub App)", () => {
  it("stores the token as before, with no refresh token or expiry", async () => {
    for (const k of Object.keys(APP_ENV)) vi.stubEnv(k, "");
    vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "github-test-client");
    vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "github-test-secret");
    jar.set("git_oauth_state", "nonce-1");
    const res = await call("github", { code: "c", state: stateFor("github") });
    expect(location(res).searchParams.get("status")).toBe("ok");
    const conn = tenant.setTenantGitConnection.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(conn).toMatchObject({ provider: "github", kind: "oauth" });
    expect(conn).not.toHaveProperty("refreshEnc");
    expect(conn).not.toHaveProperty("expiresAt");
  });
});

describe("GitHub App callback: the nonce cookie", () => {
  it("a missing cookie is bad_state before the installation is checked", async () => {
    const res = await call("github", { code: "c", installation_id: "222", setup_action: "install", state: stateFor("github") });
    expect(location(res).searchParams.get("reason")).toBe("bad_state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
    clearsCookie(res, "github");
  });

  it("a GitLab cookie value doesn't work for GitHub", async () => {
    jar.set("git_oauth_state", "nonce-other");
    const res = await call("github", { code: "c", installation_id: "222", setup_action: "install", state: stateFor("github") });
    expect(location(res).searchParams.get("reason")).toBe("bad_state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a fresh install from this browser is saved", async () => {
    jar.set("git_oauth_state", "nonce-1");
    const res = await call("github", { code: "c", installation_id: "222", setup_action: "install", state: stateFor("github") });
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ status: "ok", provider: "github" });
    expect(tenant.setTenantGitConnection).toHaveBeenCalledWith(
      "ten_A",
      "github",
      expect.objectContaining({ kind: "app", installationId: 222, accountLogin: "acme-org" }),
    );
    clearsCookie(res, "github");
  });
});

describe("GitHub App callback: arriving without our state", () => {
  it.each([
    ["an admin", admin],
    ["a member", member],
  ])("repositories changed on GitHub, for %s: confirms and saves nothing", async (_who, ctx) => {
    session.getAdminContext.mockResolvedValue(ctx);
    const res = await call("github", { installation_id: "111", setup_action: "update" });
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ status: "ok", provider: "github", updated: "1" });
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    clearsCookie(res, "github");
  });

  it.each([
    ["an admin", admin],
    ["a member", member],
  ])("install requested from an org's owners, for %s: says so and saves nothing", async (_who, ctx) => {
    session.getAdminContext.mockResolvedValue(ctx);
    const res = await call("github", { code: "c", setup_action: "request" });
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ status: "requested", provider: "github" });
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    clearsCookie(res, "github");
  });

  it("an install with a code but no state is still refused", async () => {
    const res = await call("github", { code: "unbound", installation_id: "222", setup_action: "install" });
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ status: "error", reason: "missing_code", provider: "github" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  });
});

describe("every redirect back clears the cookie", () => {
  // Built inside each test: signing needs the key stubbed in beforeEach.
  it.each([
    ["the provider's error", () => ({ error: "access_denied" })],
    ["an expired state", () => ({ code: "c", state: signState({ t: "ten_A", p: "gitlab", n: "nonce-1", ts: Date.now() - 11 * 60 * 1000 }) })],
    ["a missing code", () => ({ state: "x" })],
  ])("%s", async (_label, query: () => Record<string, string>) => {
    jar.set("git_oauth_state", "nonce-1");
    const res = await call("gitlab", query());
    expect(location(res).searchParams.get("status")).toBe("error");
    clearsCookie(res, "gitlab");
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  });

  it("a member's refusal", async () => {
    session.getAdminContext.mockResolvedValue(member);
    jar.set("git_oauth_state", "nonce-1");
    const res = await call("gitlab", { code: "c", state: stateFor("gitlab") });
    expect(location(res).searchParams.get("reason")).toBe("forbidden");
    clearsCookie(res, "gitlab");
  });
});
