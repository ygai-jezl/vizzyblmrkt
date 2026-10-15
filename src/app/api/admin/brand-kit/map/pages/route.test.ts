import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenant = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false), getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => tenant);
const backfill = vi.hoisted(() => ({ readExistingPages: vi.fn() }));
vi.mock("@/lib/brandMap/backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/brandMap/backfill")>()),
  readExistingPages: backfill.readExistingPages,
}));

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const req = (body?: unknown) =>
  new Request("http://localhost/api/admin/brand-kit/map/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  backfill.readExistingPages.mockResolvedValue({ done: true, next: null, articles: 0, sitePages: 0, removed: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/brand-kit/map/pages", () => {
  it("503s with the pages switch off, then 401s signed out and 403s for a member", async () => {
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "false");
    expect((await POST(req())).status).toBe(503);
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
    session.getAdminContext.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await POST(req())).status).toBe(403);
    expect(backfill.readExistingPages).not.toHaveBeenCalled();
  });

  it("starts from the beginning, carries on from a cursor, and refuses a made-up one", async () => {
    expect((await POST(req())).status).toBe(200);
    expect(backfill.readExistingPages).toHaveBeenLastCalledWith(admin, null);
    await POST(req({ cursor: { phase: "rows", after: "p_x" } }));
    expect(backfill.readExistingPages).toHaveBeenLastCalledWith(admin, { phase: "rows", ws: 0, offset: 0, after: "p_x" });
    expect((await POST(req({ cursor: { phase: "everything" } }))).status).toBe(400);
  });

  it("429s past its rate", async () => {
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await POST(req())).status).toBe(429);
  });
});
