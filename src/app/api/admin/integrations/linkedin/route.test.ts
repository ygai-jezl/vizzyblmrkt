import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Disconnect LinkedIn or LinkedIn Pages. LinkedIn is never revoked at LinkedIn: with the
// switches off the response is { ok: true } as before, and with both on it only adds
// revoked: "skipped". Either way the connection is deleted and LinkedIn isn't called.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ getTenantById: vi.fn(), deleteTenantSocialConnection: vi.fn() }));
vi.mock("@/lib/tenant", () => tenant);

const routes = {
  linkedin: await import("./route"),
  linkedin_org: await import("../linkedin_org/route"),
};
const { encryptToken } = await import("@/lib/social/crypto");

const ORIGIN = "https://yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SOCIAL_TOKEN_ENC_KEY", "unit-test-social-root-key-please-rotate");
  for (const v of ["LINKEDIN_OAUTH", "LINKEDIN_CM"]) {
    vi.stubEnv(`${v}_CLIENT_ID`, "client-test");
    vi.stubEnv(`${v}_CLIENT_SECRET`, "secret-test");
  }
  vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "");
  vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "");
  session.getAdminContext.mockResolvedValue(admin);
  tenant.getTenantById.mockResolvedValue({
    id: "ten_A",
    socialConnections: {
      linkedin: { platform: "linkedin", enc: encryptToken("li-access"), connectedAt: "2026-11-01T00:00:00.000Z" },
      linkedin_org: { platform: "linkedin_org", enc: encryptToken("li-org-access"), connectedAt: "2026-11-01T00:00:00.000Z" },
    },
  });
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(Object.entries(routes))("Disconnect %s", (platform, route) => {
  const call = () => route.DELETE(new Request(`${ORIGIN}/api/admin/integrations/${platform}`, { method: "DELETE" }));

  it("switches off: deletes this brand's connection, calls no provider, as before", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", platform);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the revoke switch on: deleted, never revoked", async () => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true");
    expect(await (await call()).json()).toEqual({ ok: true, revoked: "skipped" });
    expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", platform);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("both switches on: deleted, still never revoked and no tokens read", async () => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true");
    vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "true");
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: "skipped" });
    expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledTimes(1);
    expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", platform);
    expect(tenant.getTenantById).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
