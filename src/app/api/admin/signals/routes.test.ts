import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The routes: origin check, switch, sign-in and role, then the library (tested in src/lib/signals).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const api = vi.hoisted(() => ({
  lookupStatus: vi.fn(async () => ({ status: 200, body: { available: true } })),
  startLookup: vi.fn(async () => ({ status: 200, body: { signal: { id: "sig_x" } } })),
  readLookup: vi.fn(async () => ({ status: 200, body: { signal: { id: "sig_x" } } })),
  readMarket: vi.fn(async () => ({ status: 200, body: { label: "Google United States, English" } })),
  saveMarket: vi.fn(async () => ({ status: 200, body: { chosen: true } })),
}));
vi.mock("@/lib/signals/adminApi", () => api);

const serp = await import("./serp/route");
const one = await import("./serp/[id]/route");
const market = await import("../settings/search-market/route");

const MEMBER = { tenantId: "ten_A", region: "us", source: "session", role: "member" };
const ADMIN = { ...MEMBER, role: "admin" };
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/signals/serp", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_SIGNALS_ENABLED", "true");
  vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(MEMBER);
});
afterEach(() => vi.unstubAllEnvs());

describe("Get from Google routes", () => {
  it("answer 503 with the switch off, before reading the session", async () => {
    vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "false");
    expect((await serp.GET(req("GET"))).status).toBe(503);
    expect((await serp.POST(req("POST", { query: "How?" }))).status).toBe(503);
    expect((await one.GET(req("GET"), params("sig_x"))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("answer 401 when signed out, and 403 to a cross-site call", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await serp.POST(req("POST", { query: "How?" }))).status).toBe(401);
    expect((await one.GET(req("GET"), params("sig_x"))).status).toBe(401);
    expect((await serp.POST(req("POST", { query: "How?" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(api.startLookup).not.toHaveBeenCalled();
  });

  it("pass the session's brand, never one from the request", async () => {
    const res = await serp.POST(req("POST", { query: "How do I get cited?", tenantId: "ten_B" }));
    expect(res.status).toBe(200);
    expect(api.startLookup).toHaveBeenCalledWith(MEMBER, { query: "How do I get cited?", tenantId: "ten_B" });
    await one.GET(req("GET"), params("sig_x"));
    expect(api.readLookup).toHaveBeenCalledWith(MEMBER, "sig_x");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Google market route", () => {
  it("lets members read it and only admins change it", async () => {
    expect((await market.GET(req("GET"))).status).toBe(200);
    expect((await market.PUT(req("PUT", { market: { country: "GB", language: "en" } }))).status).toBe(403);
    expect(api.saveMarket).not.toHaveBeenCalled();
    session.getAdminContext.mockResolvedValue(ADMIN);
    expect((await market.PUT(req("PUT", { market: { country: "GB", language: "en" } }))).status).toBe(200);
    expect(api.saveMarket).toHaveBeenCalledWith(ADMIN, { market: { country: "GB", language: "en" } });
  });

  it("is off with the signals switch off", async () => {
    vi.stubEnv("BRAND_SIGNALS_ENABLED", "false");
    expect((await market.GET(req("GET"))).status).toBe(503);
    expect((await market.PUT(req("PUT", { market: null }))).status).toBe(503);
  });
});
