import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dismiss the weekly strategy check's row: origin, the switch, sign-in, then admin. What Dismiss
// keeps is tested with the store (src/lib/brandStrategy/check.test.ts).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ dismissStrategyCheck: vi.fn(async () => true) }));
vi.mock("@/lib/brandStrategy/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/brandStrategy/store")>()), ...store }));
const review = vi.hoisted(() => ({ forgetReviewCount: vi.fn() }));
vi.mock("@/lib/review/summary", () => review);

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const post = (headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/admin/brand-kit/map/strategy/check", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "COMPETITORS_ENABLED", "COMPETITOR_ARTICLES_ENABLED", "STRATEGY_COMPETITORS_ENABLED", "STRATEGY_CHECK_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/brand-kit/map/strategy/check", () => {
  it("503s with the check off, before sign-in", async () => {
    vi.stubEnv("STRATEGY_CHECK_ENABLED", "false");
    const r = await post();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "strategy_check_disabled" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
  });

  it("refuses another site, a signed out person and a member", async () => {
    expect((await post({ origin: "https://elsewhere.example.com", "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.getAdminContext.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(401);
    session.getAdminContext.mockResolvedValueOnce({ ...admin, role: "member" });
    const member = await post();
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ error: "forbidden" });
    expect(store.dismissStrategyCheck).not.toHaveBeenCalled();
  });

  it("dismisses the signed-in brand's row and clears its cached Review count", async () => {
    const r = await post();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, dismissed: true });
    expect(store.dismissStrategyCheck).toHaveBeenCalledWith(admin, {});
    expect(review.forgetReviewCount).toHaveBeenCalledWith("ten_A");
    store.dismissStrategyCheck.mockResolvedValueOnce(false);
    expect(await (await post()).json()).toEqual({ ok: true, dismissed: false });
  });
});
