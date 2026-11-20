import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// The repo picker refreshes a GitLab token that is about to expire before it lists,
// marks the connection when the provider rejects the token, clears the mark when a
// listing works, and never writes repo choices onto a connection removed meanwhile.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { GET, PUT } = await import("./route");
const { encryptToken, decryptToken, gitRefreshAad } = await import("@/lib/integrations/crypto");
const { getTenantById, deleteTenantGitConnection } = await import("@/lib/tenant");

const ORIGIN = "https://yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const gitlab = { params: Promise.resolve({ provider: "gitlab" }) };
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const req = (method = "GET", body?: unknown) =>
  new Request(`${ORIGIN}/api/admin/integrations/gitlab/repos`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const PROJECT = {
  path_with_namespace: "acme/app",
  web_url: "https://gitlab.com/acme/app",
  name: "app",
  visibility: "private",
  default_branch: "main",
  namespace: { full_path: "acme", kind: "group" },
};
let db: FakeFirestore;
const stored = async () => (await getTenantById("ten_A"))?.gitConnections?.gitlab;

function seed(over: Record<string, unknown> = {}) {
  db = new FakeFirestore();
  store.db = db;
  db.seed("tenants", "ten_A", {
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://example.com"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    gitConnections: {
      gitlab: {
        provider: "gitlab",
        kind: "oauth",
        enc: encryptToken("gl-old-access"),
        refreshEnc: encryptToken("gl-old-refresh", gitRefreshAad("ten_A", "gitlab")),
        expiresAt: at(Date.now() + 60 * MIN),
        connectedAt: at(Date.now() - 60 * MIN),
        repos: [],
        ...over,
      },
    },
  });
}

type Reply = Response | (() => Response | Promise<Response>);
let projects: Reply;
let tokenReply: Reply;
const reply = async (r: Reply) => (typeof r === "function" ? r() : r.clone());
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const u = String(url);
  if (u === "https://gitlab.com/oauth/token") return reply(tokenReply);
  if (u.startsWith("https://gitlab.com/api/v4/projects")) return reply(projects);
  return new Response("{}", { status: 404 });
});
const calls = () => fetchMock.mock.calls.map(([u, init]) => ({ url: String(u), auth: new Headers(init?.headers).get("authorization") }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GIT_TOKEN_ENC_KEY", "unit-test-root-key-please-rotate");
  vi.stubEnv("GIT_OAUTH_ORIGIN", ORIGIN);
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-test-client");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-test-secret");
  vi.stubEnv("GIT_REPO_SELECTION_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  projects = new Response(JSON.stringify([PROJECT]), { status: 200 });
  tokenReply = new Response(
    JSON.stringify({ access_token: "gl-new-access", refresh_token: "gl-new-refresh", expires_in: 7200 }),
    { status: 200 },
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  seed();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/admin/integrations/gitlab/repos", () => {
  it("refreshes a token near expiry before it lists, and lists with the new token", async () => {
    seed({ expiresAt: at(Date.now() + 2 * MIN) });
    const res = await GET(req(), gitlab);
    expect(res.status).toBe(200);
    expect((await res.json()).repos.map((r: { fullPath: string }) => r.fullPath)).toEqual(["acme/app"]);
    const [refresh, list] = calls();
    expect(refresh?.url).toBe("https://gitlab.com/oauth/token");
    expect(list?.url).toContain("/api/v4/projects");
    expect(list?.auth).toBe("Bearer gl-new-access");
    expect(decryptToken((await stored())!.enc!)).toBe("gl-new-access");
  });

  it("lists with the stored token when it isn't near expiry", async () => {
    const res = await GET(req(), gitlab);
    expect(res.status).toBe(200);
    expect(calls()).toEqual([expect.objectContaining({ auth: "Bearer gl-old-access" })]);
  });

  it("a rejected token marks the connection with the current token and returns 409", async () => {
    projects = new Response("{}", { status: 401 });
    const res = await GET(req(), gitlab);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "reconnect_required" });
    expect((await stored())?.reconnect?.reason).toBe("provider_rejected");
  });

  it("a token refreshed in this request and then rejected is marked on the new token", async () => {
    seed({ expiresAt: at(Date.now() + 2 * MIN) });
    projects = new Response("{}", { status: 403 });
    const res = await GET(req(), gitlab);
    expect(res.status).toBe(409);
    const conn = (await stored())!;
    expect(decryptToken(conn.enc!)).toBe("gl-new-access");
    expect(conn.reconnect?.reason).toBe("provider_rejected");
  });

  it("a successful listing clears an existing mark", async () => {
    seed({ reconnect: { at: at(Date.now() - MIN), reason: "provider_rejected" } });
    const res = await GET(req(), gitlab);
    expect(res.status).toBe(200);
    expect((await stored())?.reconnect).toBeUndefined();
  });

  it("a refresh refused in this request keeps its mark even when the old token still lists", async () => {
    seed({ expiresAt: at(Date.now() + 2 * MIN), reconnect: { at: at(Date.now() - MIN), reason: "refresh_failed" } });
    tokenReply = new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const res = await GET(req(), gitlab);
    expect(res.status).toBe(200);
    expect((await stored())?.reconnect?.reason).toBe("refresh_failed");
  });

  it("a token that won't open is 409 reconnect_required with no call out", async () => {
    seed({ enc: { ct: "x", iv: "x", tag: "x" } });
    const res = await GET(req(), gitlab);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "reconnect_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps not_connected when there is no connection", async () => {
    await deleteTenantGitConnection("ten_A", "gitlab");
    const res = await GET(req(), gitlab);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_connected" });
  });
});

describe("PUT /api/admin/integrations/gitlab/repos", () => {
  it("saves the chosen repos", async () => {
    const res = await PUT(req("PUT", { repos: ["acme/app"] }), gitlab);
    expect(res.status).toBe(200);
    expect((await stored())?.repos?.map((r) => r.fullPath)).toEqual(["acme/app"]);
  });

  it("returns 409 not_connected when the connection is removed meanwhile, and the brand still loads", async () => {
    projects = async () => {
      // A Disconnect lands while the picker re-checks the repos.
      await deleteTenantGitConnection("ten_A", "gitlab");
      return new Response(JSON.stringify([PROJECT]), { status: 200 });
    };
    const res = await PUT(req("PUT", { repos: ["acme/app"] }), gitlab);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_connected" });
    expect(await getTenantById("ten_A")).not.toBeNull();
    expect(await stored()).toBeUndefined();
  });
});
