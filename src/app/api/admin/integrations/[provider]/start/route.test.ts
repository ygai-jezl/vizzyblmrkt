import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Connect GitHub or GitLab: the start sets a nonce cookie, scoped to that provider's
// callback, whose value is the nonce inside the signed state. The callback only accepts
// a state whose nonce matches, so the flow is bound to the browser that started it.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);

const { GET } = await import("./route");
const { verifyState } = await import("@/lib/integrations/crypto");

const ORIGIN = "https://yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const start = (provider: "github" | "gitlab") =>
  GET(new Request(`${ORIGIN}/api/admin/integrations/${provider}/start`), {
    params: Promise.resolve({ provider }),
  });
const APP_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "yougrow-test",
  GITHUB_APP_CLIENT_ID: "Iv1.test",
  GITHUB_APP_CLIENT_SECRET: "test-only-secret",
  GITHUB_APP_PRIVATE_KEY: "test-only-key",
};

/** The git_oauth_state cookie's value and attributes from a response. */
function nonceCookie(res: Response) {
  const raw = res.headers.get("set-cookie") ?? "";
  const parts = raw.split(";").map((p) => p.trim());
  const [name, value] = parts[0]!.split("=");
  const attrs = Object.fromEntries(
    parts.slice(1).map((p) => {
      const [k, v] = p.split("=");
      return [k!.toLowerCase(), v ?? true];
    }),
  );
  return { name, value, attrs };
}

beforeEach(() => {
  vi.stubEnv("GIT_TOKEN_ENC_KEY", "unit-test-root-key-please-rotate");
  vi.stubEnv("GIT_OAUTH_ORIGIN", ORIGIN);
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-test-client");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-test-secret");
  for (const k of Object.keys(APP_ENV)) vi.stubEnv(k, "");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("Connect GitLab", () => {
  it("sets git_oauth_state on the GitLab callback path, httpOnly, lax, 10 minutes", async () => {
    const res = await start("gitlab");
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://gitlab.com/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/admin/integrations/gitlab/callback`);

    const cookie = nonceCookie(res);
    expect(cookie.name).toBe("git_oauth_state");
    expect(cookie.attrs.path).toBe("/api/admin/integrations/gitlab/callback");
    expect(cookie.attrs.httponly).toBe(true);
    expect(cookie.attrs.secure).toBe(true);
    expect(String(cookie.attrs.samesite).toLowerCase()).toBe("lax");
    expect(cookie.attrs["max-age"]).toBe("600");
    // The cookie holds exactly the signed state's nonce.
    const state = verifyState(to.searchParams.get("state")!);
    expect(state).toMatchObject({ t: "ten_A", p: "gitlab" });
    expect(cookie.value).toBeTruthy();
    expect(state?.n).toBe(cookie.value);
  });

  it("uses a new nonce each time", async () => {
    const a = nonceCookie(await start("gitlab")).value;
    const b = nonceCookie(await start("gitlab")).value;
    expect(a).not.toBe(b);
  });

  it("isn't Secure on plain http (local runs)", async () => {
    vi.stubEnv("GIT_OAUTH_ORIGIN", "http://localhost:3002");
    expect(nonceCookie(await start("gitlab")).attrs.secure).toBeUndefined();
  });
});

describe("Install the GitHub App", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(APP_ENV)) vi.stubEnv(k, v);
  });

  it("sets the cookie on the GitHub callback path, matching the state's nonce", async () => {
    const res = await start("github");
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://github.com/apps/yougrow-test/installations/new");
    const cookie = nonceCookie(res);
    expect(cookie.name).toBe("git_oauth_state");
    expect(cookie.attrs.path).toBe("/api/admin/integrations/github/callback");
    expect(verifyState(to.searchParams.get("state")!)?.n).toBe(cookie.value);
  });
});
