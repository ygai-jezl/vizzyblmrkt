import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route: origin check, switch, sign-in and role, then the library (tested in src/lib/content/blog).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const api = vi.hoisted(() => ({
  readTimeZone: vi.fn(async () => ({ status: 200, body: { timeZone: "UTC", chosen: false } })),
  saveTimeZone: vi.fn(async () => ({ status: 200, body: { timeZone: "Europe/London", chosen: true } })),
}));
vi.mock("@/lib/content/blog/datesAdmin", () => api);

const route = await import("./route");

const MEMBER = { tenantId: "ten_A", region: "us", source: "session", role: "member" };
const ADMIN = { ...MEMBER, role: "admin" };
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/settings/time-zone", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BLOG_DATES_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(MEMBER);
});
afterEach(() => vi.unstubAllEnvs());

describe("the time zone route", () => {
  it("lets members read it and only admins change it", async () => {
    const got = await route.GET(req("GET"));
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect((await route.PUT(req("PUT", { timeZone: "Europe/London" }))).status).toBe(403);
    expect(api.saveTimeZone).not.toHaveBeenCalled();
    session.getAdminContext.mockResolvedValue(ADMIN);
    expect((await route.PUT(req("PUT", { timeZone: "Europe/London" }))).status).toBe(200);
    expect(api.saveTimeZone).toHaveBeenCalledWith(ADMIN, { timeZone: "Europe/London" });
  });

  it("asks for sign-in, refuses other sites, and is off with its switch off", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await route.GET(req("GET"))).status).toBe(401);
    expect((await route.PUT(req("PUT", { timeZone: null }, { origin: "https://evil.example" }))).status).toBe(403);
    vi.stubEnv("BLOG_DATES_ENABLED", "false");
    expect((await route.GET(req("GET"))).status).toBe(503);
    expect((await route.PUT(req("PUT", { timeZone: null }))).status).toBe(503);
  });
});
