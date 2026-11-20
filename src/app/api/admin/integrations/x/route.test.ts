import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Disconnect X. Both switches off: delete only, { ok: true } as before. The revoke switch
// on with the X switch off: deleted, nothing revoked. Both on: read, delete, then revoke
// at X; a refused revoke still disconnects, and only this brand is touched.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const order = vi.hoisted(() => [] as string[]);
const tenant = vi.hoisted(() => ({
  getTenantById: vi.fn(),
  deleteTenantSocialConnection: vi.fn(async () => void order.push("delete")),
}));
vi.mock("@/lib/tenant", () => tenant);

const { DELETE } = await import("./route");
const { encryptToken } = await import("@/lib/social/crypto");

const ORIGIN = "https://yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const call = () => DELETE(new Request(`${ORIGIN}/api/admin/integrations/x`, { method: "DELETE" }));
const xConn = (who: string) => ({
  platform: "x",
  enc: encryptToken(`x-access-${who}`),
  refreshEnc: encryptToken(`x-refresh-${who}`),
  handle: "acme",
  userId: "1234567890",
  connectedAt: "2026-11-01T00:00:00.000Z",
});

let fetchMock: ReturnType<typeof vi.fn>;
const sentTokens = () =>
  (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(
    ([, init]) => new URLSearchParams(String(init.body)).get("token"),
  );
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  vi.stubEnv("SOCIAL_TOKEN_ENC_KEY", "unit-test-social-root-key-please-rotate");
  vi.stubEnv("X_OAUTH_CLIENT_ID", "x-test-client");
  vi.stubEnv("X_OAUTH_CLIENT_SECRET", "x-test-secret");
  vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "");
  vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "");
  session.getAdminContext.mockResolvedValue(admin);
  // The same X account is connected to two brands, each with its own tokens.
  const all: Record<string, unknown> = {
    ten_A: { id: "ten_A", socialConnections: { x: xConn("A") } },
    ten_B: { id: "ten_B", socialConnections: { x: xConn("B") } },
  };
  tenant.getTenantById.mockImplementation(async (id: string) => all[id] ?? null);
  fetchMock = vi.fn(async () => {
    order.push("revoke");
    return new Response(JSON.stringify({ revoked: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe("Disconnect X", () => {
  it("both switches off: deletes this brand's connection, calls no provider, as before", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", "x");
    expect(tenant.getTenantById).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the X switch alone: as before", async () => {
    vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "true");
    expect(await (await call()).json()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the revoke switch on and the X switch off: deleted, X not revoked", async () => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true");
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: "skipped" });
    expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", "x");
    expect(tenant.getTenantById).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("both switches on", () => {
    beforeEach(() => {
      vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true");
      vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "true");
    });

    it("deletes first, then revokes this brand's refresh and access tokens at X", async () => {
      const res = await call();
      expect(await res.json()).toEqual({ ok: true, revoked: "done" });
      expect(order).toEqual(["delete", "revoke", "revoke"]);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.x.com/2/oauth2/revoke");
      expect(sentTokens()).toEqual(["x-refresh-A", "x-access-A"]);
    });

    it("only touches this brand: the other brand's connection and tokens are left alone", async () => {
      await call();
      expect(tenant.getTenantById).toHaveBeenCalledWith("ten_A");
      expect(tenant.getTenantById).not.toHaveBeenCalledWith("ten_B");
      expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledTimes(1);
      expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", "x");
      expect(sentTokens().some((t) => t?.endsWith("-B"))).toBe(false);
    });

    it("a refused revoke still disconnects, with 200 and no token in the log", async () => {
      fetchMock.mockImplementation(async () => new Response("{}", { status: 400 }));
      const res = await call();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, revoked: "failed" });
      expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", "x");
      expect(warn.mock.calls.join(" ")).not.toMatch(/x-(access|refresh)-A/);
    });

    it("a revoke that times out still disconnects, with 200", async () => {
      fetchMock.mockImplementation(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });
      const res = await call();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, revoked: "failed" });
      expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", "x");
    });

    it("a failed read still disconnects, with nothing to revoke", async () => {
      tenant.getTenantById.mockRejectedValue(new Error("unavailable"));
      expect(await (await call()).json()).toEqual({ ok: true, revoked: "skipped" });
      expect(tenant.deleteTenantSocialConnection).toHaveBeenCalledWith("ten_A", "x");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
