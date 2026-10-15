import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The map at any size's routes: its switch, then sign-in, then admin, before anything else.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const api = vi.hoisted(() => ({
  listSubjectsFromRequest: vi.fn(async () => Response.json({ moved: true, subjects: [] })),
  createSubjectFromRequest: vi.fn(async () => Response.json({ ok: true })),
}));
vi.mock("@/lib/brandMap/recordsApi", () => api);

const { GET, POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/map/subjects", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/brand-kit/map/subjects", () => {
  it("503s with the map at any size off, before anything else", async () => {
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "false");
    const r = await GET(req("GET"));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "brand_map_scale_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("401s signed out and 403s for a member", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await POST(req("POST", { name: "x" }))).status).toBe(401);
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await POST(req("POST", { name: "x" }))).status).toBe(403);
    expect(api.createSubjectFromRequest).not.toHaveBeenCalled();
  });

  it("hands an admin's request on", async () => {
    expect((await GET(req("GET"))).status).toBe(200);
    expect((await POST(req("POST", { name: "Share of voice" }))).status).toBe(200);
    expect(api.createSubjectFromRequest).toHaveBeenCalledWith(admin, { name: "Share of voice" });
  });
});
