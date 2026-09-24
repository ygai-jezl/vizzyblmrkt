import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);

const { GET } = await import("./route");
const { verifyState } = await import("@/lib/integrations/crypto");

const ORIGIN = "https://yougrow.test";
const params = { params: Promise.resolve({ provider: "github" }) };
const start = async (query = "") => {
  const res = await GET(new Request(`${ORIGIN}/api/admin/integrations/github/start${query}`), params);
  return new URL(res.headers.get("location") ?? "");
};

beforeEach(() => {
  Object.assign(process.env, {
    GIT_TOKEN_ENC_KEY: "unit-test-root-key-please-rotate",
    GIT_OAUTH_ORIGIN: ORIGIN,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "yougrow-test",
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_CLIENT_SECRET: "test-only-secret",
    GITHUB_APP_PRIVATE_KEY: "test-only-key",
  });
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", userId: "u1" });
});

describe("Connect GitHub", () => {
  it("with linking off, goes straight to GitHub's install page", async () => {
    process.env.GITHUB_APP_LINK_ENABLED = "false";
    const to = await start();
    expect(to.origin + to.pathname).toBe("https://github.com/apps/yougrow-test/installations/new");
    expect(verifyState(to.searchParams.get("state")!)).toMatchObject({ t: "ten_A", p: "github", m: "install" });
  });

  it("with linking on, asks GitHub who's connecting first", async () => {
    process.env.GITHUB_APP_LINK_ENABLED = "true";
    const to = await start();
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("Iv1.test");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/admin/integrations/github/callback`);
    expect(verifyState(to.searchParams.get("state")!)).toMatchObject({ t: "ten_A", m: "link" });
  });

  it("'Install on another account' goes to the install page", async () => {
    process.env.GITHUB_APP_LINK_ENABLED = "true";
    const to = await start("?install=1");
    expect(to.pathname).toBe("/apps/yougrow-test/installations/new");
    expect(verifyState(to.searchParams.get("state")!)).toMatchObject({ m: "install" });
  });
});
