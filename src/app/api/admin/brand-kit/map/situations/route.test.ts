import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Buying situations' routes: their switch (which needs the map at any size), then sign-in, then admin.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const api = vi.hoisted(() => ({
  listSituationsFromRequest: vi.fn(async () => Response.json({ situations: [] })),
  createSituationFromRequest: vi.fn(async () => Response.json({ ok: true })),
}));
vi.mock("@/lib/brandMap/situationsApi", () => api);

const { GET, POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/map/situations", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/brand-kit/map/situations", () => {
  it("503s with buying situations off, or the map at any size off, before anything else", async () => {
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "false");
    expect(await (await GET(req("GET"))).json()).toEqual({ error: "situations_disabled" });
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "false");
    expect((await GET(req("GET"))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("lets a member read, and only an admin add", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await GET(req("GET"))).status).toBe(200);
    expect((await POST(req("POST", { text: "x" }))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req("GET"))).status).toBe(401);
    expect(api.createSituationFromRequest).not.toHaveBeenCalled();
  });
});
