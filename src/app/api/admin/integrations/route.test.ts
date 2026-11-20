import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The connections status: what's connected for this brand, and canEdit so the panel can
// hide what a member can't use. Never a token, sealed or not.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => tenant);

const { GET } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const SEALED = { v: 1, iv: "c2VhbGVkLWl2", tag: "c2VhbGVkLXRhZw", ct: "c2VhbGVkLWNpcGhlcnRleHQ" };
const req = () => new Request("http://localhost/api/admin/integrations");

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GIT_TOKEN_ENC_KEY", "unit-test-root-key-please-rotate");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-test-client");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-test-secret");
  session.getAdminContext.mockResolvedValue(admin);
  tenant.getTenantById.mockResolvedValue({
    id: "ten_A",
    gitConnections: {
      gitlab: { provider: "gitlab", kind: "oauth", enc: SEALED, accountLogin: "acme-dev", connectedAt: "2026-11-01T00:00:00.000Z" },
    },
    socialConnections: {
      x: { platform: "x", enc: SEALED, refreshEnc: SEALED, handle: "acme", userId: "123", connectedAt: "2026-11-01T00:00:00.000Z" },
      linkedin: { platform: "linkedin", enc: SEALED, refreshEnc: null, handle: "Ada Example", userId: "sub-1", connectedAt: "2026-11-01T00:00:00.000Z" },
    },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/integrations", () => {
  it("says an admin can edit", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canEdit).toBe(true);
    expect(body.providers.gitlab).toMatchObject({ connected: true, accountLogin: "acme-dev" });
    expect(tenant.getTenantById).toHaveBeenCalledWith("ten_A");
  });

  it("says a member can't, and still shows what's connected", async () => {
    session.getAdminContext.mockResolvedValue(member);
    const body = await (await GET(req())).json();
    expect(body.canEdit).toBe(false);
    expect(body.providers.x).toMatchObject({ connected: true, accountLogin: "acme" });
  });

  it("never returns a token or a sealed blob", async () => {
    const res = await GET(req());
    const text = await res.text();
    const keys = keysOf(JSON.parse(text));
    expect(keys).not.toContain("enc");
    expect(keys).not.toContain("refreshEnc");
    for (const part of Object.values(SEALED)) {
      if (typeof part === "string") expect(text).not.toContain(part);
    }
  });

  it("401s when signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });
});
