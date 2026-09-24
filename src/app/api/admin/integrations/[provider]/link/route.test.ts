import { beforeEach, describe, expect, it, vi } from "vitest";

// "Which GitHub account?": only an install from this tenant's signed choice list can be saved.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ setTenantGitConnection: vi.fn() }));
vi.mock("@/lib/tenant", () => tenant);

const { GET, POST } = await import("./route");
const { chooseToken } = await import("@/lib/integrations/githubAppLink");

const ORIGIN = "https://yougrow.test";
const params = { params: Promise.resolve({ provider: "github" }) };
const headers = { host: "yougrow.test", origin: ORIGIN, "content-type": "application/json" };
const get = (c: string) => GET(new Request(`${ORIGIN}/api/admin/integrations/github/link?c=${encodeURIComponent(c)}`, { headers }), params);
const post = (body: unknown) =>
  POST(new Request(`${ORIGIN}/api/admin/integrations/github/link`, { method: "POST", headers, body: JSON.stringify(body) }), params);
const install = (id: number, login: string) => ({
  installationId: id,
  accountLogin: login,
  accountType: "Organization" as const,
  repositorySelection: "selected",
  readOnly: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, {
    GIT_TOKEN_ENC_KEY: "unit-test-root-key-please-rotate",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "yougrow-test",
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "test-only-secret",
    GITHUB_APP_PRIVATE_KEY: "test-only-key",
    GITHUB_APP_LINK_ENABLED: "true",
  });
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", userId: "u1" });
});

describe("GitHub 'Which account?' step", () => {
  it("lists the choices and saves the one picked", async () => {
    const c = chooseToken("ten_A", [install(1, "acme-org"), install(2, "acme")]);
    const listed = await get(c);
    expect((await listed.json()).choices.map((x: { accountLogin: string }) => x.accountLogin)).toEqual(["acme-org", "acme"]);

    const saved = await post({ c, installationId: 2 });
    expect(saved.status).toBe(200);
    expect(tenant.setTenantGitConnection).toHaveBeenCalledWith("ten_A", "github", expect.objectContaining({ kind: "app", installationId: 2, accountLogin: "acme" }));
  });

  it("refuses an install that wasn't offered, or another tenant's choice", async () => {
    const c = chooseToken("ten_A", [install(1, "acme-org")]);
    expect((await post({ c, installationId: 99 })).status).toBe(400);
    session.getAdminContext.mockResolvedValue({ tenantId: "ten_B", userId: "u2" });
    const other = await post({ c, installationId: 1 });
    expect(await other.json()).toEqual({ error: "choice_expired" });
    expect(tenant.setTenantGitConnection).not.toHaveBeenCalled();
  });

  it("is off with linking off", async () => {
    process.env.GITHUB_APP_LINK_ENABLED = "false";
    expect((await get(chooseToken("ten_A", [install(1, "x")]))).status).toBe(404);
  });
});
