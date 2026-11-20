import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Disconnect GitHub or GitLab. Switch off: delete only, no provider call, { ok: true } as
// before. Switch on: read, delete, then revoke best effort; a failed or slow revoke still
// disconnects, a GitHub App is never uninstalled, and only this brand is touched.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const order = vi.hoisted(() => [] as string[]);
const tenant = vi.hoisted(() => ({
  getTenantById: vi.fn(),
  deleteTenantGitConnection: vi.fn(async () => void order.push("delete")),
}));
vi.mock("@/lib/tenant", () => tenant);

const { DELETE } = await import("./route");
const { encryptToken, gitRefreshAad } = await import("@/lib/integrations/crypto");

const ORIGIN = "https://yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const call = (provider: string) =>
  DELETE(new Request(`${ORIGIN}/api/admin/integrations/${provider}`, { method: "DELETE" }), {
    params: Promise.resolve({ provider }),
  });

/** Each brand's own stored connections. */
function brands() {
  return {
    ten_A: {
      id: "ten_A",
      gitConnections: {
        gitlab: {
          provider: "gitlab",
          kind: "oauth",
          enc: encryptToken("gl-access-A"),
          refreshEnc: encryptToken("gl-refresh-A", gitRefreshAad("ten_A", "gitlab")),
          connectedAt: "2026-11-20T10:00:00.000Z",
        },
        github: { provider: "github", kind: "oauth", enc: encryptToken("gho_classic_A"), connectedAt: "2026-11-01T00:00:00.000Z" },
      },
    },
    ten_B: {
      id: "ten_B",
      gitConnections: {
        gitlab: {
          provider: "gitlab",
          kind: "oauth",
          enc: encryptToken("gl-access-B"),
          refreshEnc: encryptToken("gl-refresh-B", gitRefreshAad("ten_B", "gitlab")),
          connectedAt: "2026-11-20T10:00:00.000Z",
        },
      },
    },
  } as Record<string, unknown>;
}

let fetchMock: ReturnType<typeof vi.fn>;
const sentBody = () => Object.fromEntries(new URLSearchParams(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)));
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  vi.stubEnv("GIT_TOKEN_ENC_KEY", "unit-test-root-key-please-rotate");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-test-client");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-test-secret");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "github-test-client");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "github-test-secret");
  vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "");
  vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "");
  session.getAdminContext.mockResolvedValue(admin);
  const all = brands();
  tenant.getTenantById.mockImplementation(async (id: string) => all[id] ?? null);
  fetchMock = vi.fn(async () => {
    order.push("revoke");
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe("Disconnect with the revoke switches off", () => {
  it("deletes this brand's connection and calls no provider, as before", async () => {
    const res = await call("gitlab");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(tenant.deleteTenantGitConnection).toHaveBeenCalledWith("ten_A", "gitlab");
    expect(tenant.getTenantById).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the X switch alone changes nothing", async () => {
    vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "true");
    expect(await (await call("github")).json()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Disconnect with CONNECTOR_REVOKE_ENABLED on", () => {
  beforeEach(() => vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true"));

  it("GitLab: deletes first, then revokes this brand's refresh token", async () => {
    const res = await call("gitlab");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: "done" });
    expect(order).toEqual(["delete", "revoke"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gitlab.com/oauth/revoke");
    expect(sentBody()).toMatchObject({ token: "gl-refresh-A", token_type_hint: "refresh_token" });
  });

  it("only touches this brand: another brand's connection and tokens are left alone", async () => {
    await call("gitlab");
    expect(tenant.getTenantById).toHaveBeenCalledWith("ten_A");
    expect(tenant.getTenantById).not.toHaveBeenCalledWith("ten_B");
    expect(tenant.deleteTenantGitConnection).toHaveBeenCalledTimes(1);
    expect(tenant.deleteTenantGitConnection).toHaveBeenCalledWith("ten_A", "gitlab");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/gl-(access|refresh)-B/);
  });

  it("classic GitHub: revokes that one token, never the grant", async () => {
    fetchMock.mockImplementationOnce(async () => {
      order.push("revoke");
      return new Response(null, { status: 204 });
    });
    expect(await (await call("github")).json()).toEqual({ ok: true, revoked: "done" });
    expect(order).toEqual(["delete", "revoke"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/applications/github-test-client/token");
  });

  it("a GitHub App: deleted here, never uninstalled, no provider call", async () => {
    tenant.getTenantById.mockResolvedValue({
      id: "ten_A",
      gitConnections: { github: { provider: "github", kind: "app", installationId: 222, connectedAt: "2026-11-01T00:00:00.000Z" } },
    });
    expect(await (await call("github")).json()).toEqual({ ok: true, revoked: "skipped" });
    expect(tenant.deleteTenantGitConnection).toHaveBeenCalledWith("ten_A", "github");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refused revoke still disconnects, with 200", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 400 }));
    const res = await call("gitlab");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: "failed" });
    expect(tenant.deleteTenantGitConnection).toHaveBeenCalledWith("ten_A", "gitlab");
    expect(warn.mock.calls.join(" ")).not.toMatch(/gl-(access|refresh)/);
  });

  it("a revoke that times out still disconnects, with 200", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const res = await call("gitlab");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: "failed" });
    expect(tenant.deleteTenantGitConnection).toHaveBeenCalledWith("ten_A", "gitlab");
  });

  it("a failed read still disconnects, with nothing to revoke", async () => {
    tenant.getTenantById.mockRejectedValue(new Error("unavailable"));
    expect(await (await call("gitlab")).json()).toEqual({ ok: true, revoked: "skipped" });
    expect(tenant.deleteTenantGitConnection).toHaveBeenCalledWith("ten_A", "gitlab");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nothing connected: still ok, skipped", async () => {
    tenant.getTenantById.mockResolvedValue({ id: "ten_A", gitConnections: {} });
    expect(await (await call("gitlab")).json()).toEqual({ ok: true, revoked: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unknown provider is 400 with nothing deleted", async () => {
    const res = await call("bitbucket");
    expect(res.status).toBe(400);
    expect(tenant.deleteTenantGitConnection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
