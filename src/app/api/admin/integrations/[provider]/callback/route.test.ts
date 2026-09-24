import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Connecting the read-only GitHub App: an install GitHub reports outside our
// signed flow is never saved as-is, and linking only offers installs the person
// can access — saved when they pick one.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ getTenantById: vi.fn(), setTenantGitConnection: vi.fn() }));
vi.mock("@/lib/tenant", () => tenant);

const { GET } = await import("./route");
const { verifyState } = await import("@/lib/integrations/crypto");
const { chooseToken, connectState, readChooseToken } = await import("@/lib/integrations/githubAppLink");

const ORIGIN = "https://yougrow.test";
const params = { params: Promise.resolve({ provider: "github" }) };
const admin = { tenantId: "ten_A", region: "us", source: "session", userId: "u1", role: "admin" };
const call = (query: Record<string, string>) =>
  GET(new Request(`${ORIGIN}/api/admin/integrations/github/callback?${new URLSearchParams(query)}`), params);
const location = (res: Response) => new URL(res.headers.get("location") ?? "");

type Install = { id: number; account: { login: string; type: string }; permissions: Record<string, string>; repository_selection: string };
let installs: Install[] = [];
const fetchMock = vi.fn(async (url: string) =>
  String(url).includes("login/oauth/access_token")
    ? new Response(JSON.stringify({ access_token: "ghu_user" }), { status: 200 })
    : new Response(JSON.stringify({ installations: installs }), { status: 200 }),
);
const org = (id: number, perms: Record<string, string> = { contents: "read", metadata: "read" }): Install => ({
  id,
  account: { login: "acme-org", type: "Organization" },
  permissions: perms,
  repository_selection: "selected",
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, {
    GIT_TOKEN_ENC_KEY: "unit-test-root-key-please-rotate",
    GIT_OAUTH_ORIGIN: ORIGIN,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "yougrow-test",
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "test-only-secret",
    GITHUB_APP_PRIVATE_KEY: "test-only-key",
    GITHUB_APP_LINK_ENABLED: "true",
  });
  session.getAdminContext.mockResolvedValue(admin);
  tenant.getTenantById.mockResolvedValue({ gitConnections: {} });
  installs = [org(222)];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub App callback — after the person authorises", () => {
  it("lists the install GitHub named first, and saves nothing until a click", async () => {
    installs = [org(111), org(222)];
    const to = location(await call({ code: "c", state: connectState("ten_A", "link", 222) }));
    expect(to.searchParams.get("choose")).toBe("github");
    expect(readChooseToken(to.searchParams.get("c")!, "ten_A")?.map((x) => x.installationId)).toEqual([222, 111]);
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  });

  it("leaves out an install they can't access, or one that could write", async () => {
    installs = [org(111)];
    let to = location(await call({ code: "c", state: connectState("ten_A", "link", 999) }));
    expect(readChooseToken(to.searchParams.get("c")!, "ten_A")?.map((x) => x.installationId)).toEqual([111]);
    installs = [org(222, { contents: "write" }), org(333)];
    to = location(await call({ code: "c", state: connectState("ten_A", "link", 222) }));
    expect(readChooseToken(to.searchParams.get("c")!, "ten_A")?.map((x) => x.installationId)).toEqual([333]);
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  });

  it("installed nowhere they can reach: on to GitHub's install page", async () => {
    installs = [];
    const to = location(await call({ code: "c", state: connectState("ten_A", "link") }));
    expect(to.origin + to.pathname).toBe("https://github.com/apps/yougrow-test/installations/new");
    expect(verifyState(to.searchParams.get("state")!)).toMatchObject({ t: "ten_A", m: "install" });
  });

  it("installed somewhere: asks which account, listing only read-only installs", async () => {
    installs = [org(222), org(333, { contents: "write" })];
    const to = location(await call({ code: "c", state: connectState("ten_A", "link") }));
    expect(to.pathname).toBe("/admin/account/connections");
    expect(to.searchParams.get("choose")).toBe("github");
    expect(readChooseToken(to.searchParams.get("c")!, "ten_A")?.map((x) => x.installationId)).toEqual([222]);
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  });

  it("never accepts a choice token as OAuth state", async () => {
    const choice = chooseToken("ten_A", [{ installationId: 222, accountLogin: "x", accountType: "User", repositorySelection: "all", readOnly: true }]);
    const to = location(await call({ code: "c", installation_id: "222", setup_action: "install", state: choice }));
    expect(to.searchParams.get("reason")).toBe("bad_state");
  });

  it("a fresh install from our flow is saved with its account", async () => {
    const to = location(await call({ code: "c", installation_id: "222", setup_action: "install", state: connectState("ten_A", "install") }));
    expect(Object.fromEntries(to.searchParams)).toEqual({ status: "ok", provider: "github" });
    expect(tenant.setTenantGitConnection).toHaveBeenCalledWith(
      "ten_A",
      "github",
      expect.objectContaining({ installationId: 222, accountType: "Organization" }),
    );
  });
});
