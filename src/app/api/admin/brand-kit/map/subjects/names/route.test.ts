import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An article's subject search: any member of the brand reads every subject's name.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const api = vi.hoisted(() => ({ subjectNamesFromRequest: vi.fn(async () => Response.json({ subjects: [] })) }));
vi.mock("@/lib/brandMap/recordsApi", () => api);

const { GET } = await import("./route");
const member = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_member", role: "member" };
const req = () => new Request("http://localhost/api/admin/brand-kit/map/subjects/names");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(member);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/brand-kit/map/subjects/names", () => {
  it("answers a member of the brand", async () => {
    expect((await GET(req())).status).toBe(200);
    expect(api.subjectNamesFromRequest).toHaveBeenCalledWith(member);
  });

  it("401s signed out, and 503s with the map at any size off", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "false");
    expect((await GET(req())).status).toBe(503);
  });
});
