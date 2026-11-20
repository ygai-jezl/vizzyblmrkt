import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only a brand admin connects, disconnects or picks repos. A member can still see what's
// connected (the status and installation reads), and gets a 403 or the forbidden redirect
// everywhere else, with nothing written and no call to the provider.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({
  getTenantById: vi.fn(),
  setTenantGitConnection: vi.fn(),
  deleteTenantGitConnection: vi.fn(),
  setTenantGitRepos: vi.fn(),
}));
vi.mock("@/lib/tenant", () => tenant);

const status = await import("./route");
const gitStart = await import("./[provider]/start/route");
const gitCallback = await import("./[provider]/callback/route");
const gitDelete = await import("./[provider]/route");
const gitRepos = await import("./[provider]/repos/route");
const gitInstallation = await import("./[provider]/installation/route");
const { encryptToken, signState } = await import("@/lib/integrations/crypto");

const ORIGIN = "https://yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const gitlab = { params: Promise.resolve({ provider: "gitlab" }) };
const github = { params: Promise.resolve({ provider: "github" }) };
const req = (path: string, method = "GET", body?: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const location = (res: Response) => new URL(res.headers.get("location") ?? "");

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "glpat-test" }), { status: 200 }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GIT_TOKEN_ENC_KEY", "unit-test-root-key-please-rotate");
  vi.stubEnv("GIT_OAUTH_ORIGIN", ORIGIN);
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-test-client");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-test-secret");
  vi.stubEnv("GIT_REPO_SELECTION_ENABLED", "true");
  for (const v of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]) {
    vi.stubEnv(v, "");
  }
  session.getAdminContext.mockResolvedValue(member);
  tenant.getTenantById.mockResolvedValue({
    id: "ten_A",
    gitConnections: {
      gitlab: { provider: "gitlab", kind: "oauth", enc: encryptToken("glpat-stored"), connectedAt: "2026-11-01T00:00:00.000Z", repos: [] },
    },
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectNothingWritten() {
  expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  expect(tenant.deleteTenantGitConnection).not.toHaveBeenCalled();
  expect(tenant.setTenantGitRepos).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

describe("GitHub and GitLab, as a member", () => {
  it("start sends them back with reason=forbidden and sets no cookie", async () => {
    const res = await gitStart.GET(req("/api/admin/integrations/gitlab/start"), gitlab);
    const to = location(res);
    expect(to.origin + to.pathname).toBe(`${ORIGIN}/admin/account/connections`);
    expect(Object.fromEntries(to.searchParams)).toEqual({ status: "error", reason: "forbidden", provider: "gitlab" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expectNothingWritten();
  });

  it("callback with a code and state is refused before any exchange", async () => {
    const state = signState({ t: "ten_A", p: "gitlab", n: "nonce-1", ts: Date.now() });
    const res = await gitCallback.GET(req(`/api/admin/integrations/gitlab/callback?code=c&state=${state}`), gitlab);
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ status: "error", reason: "forbidden", provider: "gitlab" });
    expectNothingWritten();
  });

  it("DELETE, repos GET and repos PUT are 403 with nothing written", async () => {
    const del = await gitDelete.DELETE(req("/api/admin/integrations/gitlab", "DELETE"), gitlab);
    expect(del.status).toBe(403);
    expect(await del.json()).toEqual({ error: "forbidden" });
    const list = await gitRepos.GET(req("/api/admin/integrations/gitlab/repos"), gitlab);
    expect(list.status).toBe(403);
    const save = await gitRepos.PUT(req("/api/admin/integrations/gitlab/repos", "PUT", { repos: ["acme/web"] }), gitlab);
    expect(save.status).toBe(403);
    expectNothingWritten();
  });

  it("can still read the status and the GitHub installation", async () => {
    const s = await status.GET(req("/api/admin/integrations"));
    expect(s.status).toBe(200);
    const i = await gitInstallation.GET(req("/api/admin/integrations/github/installation"), github);
    expect(i.status).toBe(200);
    expectNothingWritten();
  });
});

describe("GitHub and GitLab, signed out", () => {
  beforeEach(() => session.getAdminContext.mockResolvedValue(null));

  it("is 401 on every route, and the callback goes to sign in", async () => {
    expect((await gitStart.GET(req("/api/admin/integrations/gitlab/start"), gitlab)).status).toBe(401);
    expect((await gitDelete.DELETE(req("/api/admin/integrations/gitlab", "DELETE"), gitlab)).status).toBe(401);
    expect((await gitRepos.GET(req("/api/admin/integrations/gitlab/repos"), gitlab)).status).toBe(401);
    expect((await gitRepos.PUT(req("/api/admin/integrations/gitlab/repos", "PUT", { repos: [] }), gitlab)).status).toBe(401);
    expect((await status.GET(req("/api/admin/integrations"))).status).toBe(401);
    expect((await gitInstallation.GET(req("/api/admin/integrations/github/installation"), github)).status).toBe(401);
    const cb = await gitCallback.GET(req("/api/admin/integrations/gitlab/callback?code=c&state=s"), gitlab);
    expect(cb.headers.get("location")).toBe(`${ORIGIN}/login`);
    expectNothingWritten();
  });
});

describe("GitHub and GitLab, as an admin", () => {
  beforeEach(() => session.getAdminContext.mockResolvedValue(admin));

  it("start still goes to the provider", async () => {
    const to = location(await gitStart.GET(req("/api/admin/integrations/gitlab/start"), gitlab));
    expect(to.origin + to.pathname).toBe("https://gitlab.com/oauth/authorize");
  });

  it("DELETE still disconnects this brand", async () => {
    const res = await gitDelete.DELETE(req("/api/admin/integrations/gitlab", "DELETE"), gitlab);
    expect(res.status).toBe(200);
    expect(tenant.deleteTenantGitConnection).toHaveBeenCalledWith("ten_A", "gitlab");
  });
});
