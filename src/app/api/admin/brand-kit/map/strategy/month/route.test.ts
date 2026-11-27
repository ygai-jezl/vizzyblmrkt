import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// How it went's route (STRATEGY_RESULTS_ENABLED): origin, the switch (which needs the strategy), then
// sign-in, then admin for the run by hand. The data side is tested in src/lib/brandStrategy.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), isRateLimited: limits.isRateLimited }));
const view = vi.hoisted(() => ({
  monthsFromRequest: vi.fn(async () => Response.json({ howItWent: { months: [] } })),
  runMonthFromRequest: vi.fn(async () => Response.json({ howItWent: { months: [{ month: "2026-11" }] } })),
}));
vi.mock("@/lib/brandStrategy/monthView", () => view);

const route = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const req = (method: string, origin?: string) =>
  new Request("http://localhost/api/admin/brand-kit/map/strategy/month", { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) } });
const post = (origin?: string) => route.POST(req("POST", origin));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/brand-kit/map/strategy/month", () => {
  it("503s with its switch off, or the strategy off, before anything else", async () => {
    const off = await post();
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "strategy_results_disabled" });
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "true");
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "false");
    expect((await post()).status).toBe(503);
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(view.runMonthFromRequest).not.toHaveBeenCalled();
  });

  it("refuses another site, 401s signed out, 403s a member and 429s past the brand's limit", async () => {
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "true");
    expect((await post("https://elsewhere.example")).status).toBe(403);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(401);
    session.getAdminContext.mockResolvedValueOnce({ ...admin, role: "member" });
    expect((await post()).status).toBe(403);
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await post()).status).toBe(429);
    expect(view.runMonthFromRequest).not.toHaveBeenCalled();
  });

  it("runs the look for the caller's own brand, with the brand from the session only", async () => {
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "true");
    const r = await post();
    expect(r.status).toBe(200);
    expect(view.runMonthFromRequest).toHaveBeenCalledWith(admin);
    expect(limits.isRateLimited).toHaveBeenCalledWith("tenant:ten_A", expect.objectContaining({ prefix: "strategy_month" }), expect.anything());
  });
});
