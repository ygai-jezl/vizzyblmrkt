import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route: origin check, switch, sign-in and role, then the library (tested in src/lib/content/blog).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const api = vi.hoisted(() => ({
  readRefresh: vi.fn(async () => ({ status: 200, body: { clock: "test", share: 1 } })),
  saveRefresh: vi.fn(async () => ({ status: 200, body: { clock: 30, share: 1 } })),
}));
vi.mock("@/lib/content/blog/refreshAdmin", () => api);

const route = await import("./route");

const MEMBER = { tenantId: "ten_A", region: "us", source: "session", role: "member" };
const ADMIN = { ...MEMBER, role: "admin" };
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/settings/refresh", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  for (const sw of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED"]) vi.stubEnv(sw, "true");
  session.getAdminContext.mockResolvedValue(MEMBER);
});
afterEach(() => vi.unstubAllEnvs());

describe("the refresh settings route", () => {
  it("lets members read it and only admins change it", async () => {
    const got = await route.GET(req("GET"));
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect((await route.PUT(req("PUT", { clock: 30, share: 1 }))).status).toBe(403);
    expect(api.saveRefresh).not.toHaveBeenCalled();
    session.getAdminContext.mockResolvedValue(ADMIN);
    expect((await route.PUT(req("PUT", { clock: 30, share: 1 }))).status).toBe(200);
    expect(api.saveRefresh).toHaveBeenCalledWith(ADMIN, { clock: 30, share: 1 });
  });

  it("asks for sign-in, refuses other sites, and is off with its switch off", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await route.GET(req("GET"))).status).toBe(401);
    expect((await route.PUT(req("PUT", { clock: "test", share: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "false");
    expect((await route.GET(req("GET"))).status).toBe(503);
    expect((await route.PUT(req("PUT", { clock: "test", share: 1 }))).status).toBe(503);
  });
});
