import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Content plan's routes: the switch (which needs the strategy and the brand map), then sign-in, then admin, then input.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const make = vi.hoisted(() => ({ makeContentPlan: vi.fn(async () => ({ ok: false as const, status: 409, error: "no_brand_map" })) }));
vi.mock("@/lib/contentStrategy/make", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/contentStrategy/make")>()), makeContentPlan: make.makeContentPlan }));
// No record yet: nothing here reaches a database.
vi.mock("@/lib/contentStrategy/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/contentStrategy/store")>()), readContentStrategyDoc: vi.fn(async () => null) }));

const main = await import("./route");
const makeRoute = await import("./make/route");
const approve = await import("./approve/route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const req = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/admin/brand-kit/map/strategy/content${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
  vi.stubEnv("CONTENT_STRATEGY_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

const writes = () => [
  main.PUT(req("", "PUT", { op: "rename_pillar", baseRev: 0, pillarId: "pil_aaaaaa01", name: "Get cited" })),
  main.DELETE(req("", "DELETE")),
  makeRoute.POST(req("/make", "POST")),
  approve.POST(req("/approve", "POST", { baseRev: 0 })),
];

describe("/api/admin/brand-kit/map/strategy/content", () => {
  it("503s with the content strategy, the brand strategy or the brand map off, before anything else", async () => {
    vi.stubEnv("CONTENT_STRATEGY_ENABLED", "false");
    expect(await (await main.GET(req("", "GET"))).json()).toEqual({ error: "content_strategy_disabled" });
    for (const r of await Promise.all(writes())) expect(r.status).toBe(503);
    vi.stubEnv("CONTENT_STRATEGY_ENABLED", "true");
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "false");
    expect((await main.GET(req("", "GET"))).status).toBe(503);
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_ENABLED", "false");
    expect((await main.GET(req("", "GET"))).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(make.makeContentPlan).not.toHaveBeenCalled();
  });

  it("401s when signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await main.GET(req("", "GET"))).status).toBe(401);
    for (const r of await Promise.all(writes())) expect(r.status).toBe(401);
  });

  it("lets a member read but change nothing", async () => {
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    const read = await main.GET(req("", "GET"));
    expect(read.status).toBe(200);
    expect((await read.json()).plan).toMatchObject({ state: "none", rev: 0 });
    for (const r of await Promise.all(writes())) expect(r.status).toBe(403);
    expect(limits.isRateLimited).not.toHaveBeenCalled();
    expect(make.makeContentPlan).not.toHaveBeenCalled();
  });

  it("400s input it can't read, before reading or spending anything", async () => {
    const bad = await Promise.all([
      main.PUT(req("", "PUT", { op: "rename_pillar", pillarId: "pil_aaaaaa01", name: "No base revision" })),
      main.PUT(req("", "PUT", { op: "explode", baseRev: 0 })),
      main.PUT(req("", "PUT", { op: "skip", baseRev: 0, slotId: "slt_aaaaaa01", reason: "", tenantId: "ten_B" })),
      main.PUT(req("", "PUT", { op: "move", baseRev: 0, slotId: "slt_aaaaaa01", week: "next week" })),
      approve.POST(req("/approve", "POST", { baseRev: -1 })),
      main.GET(req("?pillar=../../etc", "GET")),
    ]);
    for (const r of bad) {
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_input" });
    }
  });

  it("429s Make the plan past the brand's limit, and says why a make was refused", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await makeRoute.POST(req("/make", "POST"))).status).toBe(429);
    expect(limits.isRateLimited).toHaveBeenCalledWith("tenant:ten_A", expect.objectContaining({ prefix: "content_plan_make" }), expect.anything());
    const refused = await makeRoute.POST(req("/make", "POST"));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "no_brand_map" });
    expect(make.makeContentPlan).toHaveBeenCalledWith(admin, {});
  });
});
