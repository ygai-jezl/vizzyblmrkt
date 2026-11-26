import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Strategy tab's routes: the switch (which needs the brand map), then sign-in, then admin, then input.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));

const main = await import("./route");
const propose = await import("./propose/route");
const approve = await import("./approve/route");
const competitors = await import("./competitors/route");
const isNot = await import("./is-not/route");
const notCompetitor = await import("./competitors/not/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const req = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/admin/brand-kit/map/strategy${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
  vi.stubEnv("COMPETITOR_FINDER_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

const writes = () => [
  main.PUT(req("", "PUT", { baseRev: 0 })),
  main.DELETE(req("", "DELETE")),
  propose.POST(req("/propose", "POST")),
  approve.POST(req("/approve", "POST", { baseRev: 0 })),
  isNot.POST(req("/is-not", "POST", { baseRev: 0, text: "Not an agency", accept: true })),
];

describe("/api/admin/brand-kit/map/strategy", () => {
  it("503s with the strategy off, or the brand map off, before anything else", async () => {
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "false");
    expect(await (await main.GET(req("", "GET"))).json()).toEqual({ error: "brand_strategy_disabled" });
    for (const r of await Promise.all(writes())) expect(r.status).toBe(503);
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_ENABLED", "false");
    expect((await main.GET(req("", "GET"))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("the finder 503s with its own switch off, even with the strategy on", async () => {
    vi.stubEnv("COMPETITOR_FINDER_ENABLED", "false");
    const r = await competitors.POST(req("/competitors", "POST", { mode: "quick" }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "competitor_finder_disabled" });
  });

  it("Not a competitor 503s unless the strategy is joined to Competitors, then checks sign-in, admin and input", async () => {
    const post = (body: unknown) => notCompetitor.POST(req("/competitors/not", "POST", body));
    const off = await post({ name: "Rivalco" });
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "strategy_competitors_disabled" });
    vi.stubEnv("STRATEGY_COMPETITORS_ENABLED", "true");
    // Joined needs Competitors on too.
    expect((await post({ name: "Rivalco" })).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await post({ name: "Rivalco" })).status).toBe(401);
    session.getAdminContext.mockResolvedValueOnce({ ...admin, role: "member" });
    expect((await post({ name: "Rivalco" })).status).toBe(403);
    for (const bad of [{ name: "" }, { name: "Rivalco", tenantId: "ten_B" }, { site: "rivalco.example" }]) {
      const r = await post(bad);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_input" });
    }
  });

  it("401s when signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await main.GET(req("", "GET"))).status).toBe(401);
    for (const r of await Promise.all([...writes(), competitors.POST(req("/competitors", "POST", { mode: "quick" }))])) expect(r.status).toBe(401);
  });

  it("lets a member read but change nothing", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    for (const r of await Promise.all([...writes(), competitors.POST(req("/competitors", "POST", { mode: "full" }))])) expect(r.status).toBe(403);
    expect(limits.isRateLimited).not.toHaveBeenCalled();
  });

  it("400s input it can't read, before reading or spending anything", async () => {
    const bad = await Promise.all([
      main.PUT(req("", "PUT", { audiences: ["No base revision"] })),
      main.PUT(req("", "PUT", { baseRev: 0, tenantId: "ten_B" })),
      main.PUT(req("", "PUT", { baseRev: 0, focusSituationIds: ["not-an-id"] })),
      approve.POST(req("/approve", "POST", { baseRev: -1 })),
      competitors.POST(req("/competitors", "POST", { mode: "everything" })),
      isNot.POST(req("/is-not", "POST", { baseRev: 0, text: "x".repeat(200), accept: true })),
    ]);
    for (const r of bad) {
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_input" });
    }
  });

  it("429s Propose and the finder past the brand's limit", async () => {
    limits.isRateLimited.mockResolvedValue(true);
    expect((await propose.POST(req("/propose", "POST"))).status).toBe(429);
    expect((await competitors.POST(req("/competitors", "POST", { mode: "quick" }))).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenCalledWith("tenant:ten_A", expect.objectContaining({ prefix: "strategy_propose" }), expect.anything());
  });
});
