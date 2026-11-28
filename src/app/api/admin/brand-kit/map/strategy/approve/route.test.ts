import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Approve strategy: origin, the switch, sign-in, admin, then the approval. A successful one forgets
// the brand's cached Review count, since it can settle the month's suggestion or start the weekly
// check again. What approving keeps is tested with the store (src/lib/brandStrategy/store.test.ts).
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const api = vi.hoisted(() => ({ approveFromRequest: vi.fn(async () => Response.json({ ok: true })) }));
vi.mock("@/lib/brandStrategy/adminApi", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/brandStrategy/adminApi")>()), approveFromRequest: api.approveFromRequest }));
const review = vi.hoisted(() => ({ forgetReviewCount: vi.fn() }));
vi.mock("@/lib/review/summary", () => review);

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const post = (headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/admin/brand-kit/map/strategy/approve", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ baseRev: 3 }) }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED"]) vi.stubEnv(k, "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/brand-kit/map/strategy/approve", () => {
  it("approves for the signed-in brand and forgets its cached Review count", async () => {
    const r = await post();
    expect(r.status).toBe(200);
    expect(api.approveFromRequest).toHaveBeenCalledWith(admin, { baseRev: 3 });
    expect(review.forgetReviewCount).toHaveBeenCalledWith("ten_A");
  });

  it("keeps the count when nothing was approved, or the request was refused", async () => {
    api.approveFromRequest.mockResolvedValueOnce(Response.json({ error: "strategy_changed" }, { status: 409 }));
    expect((await post()).status).toBe(409);
    session.getAdminContext.mockResolvedValueOnce({ ...admin, role: "member" });
    expect((await post()).status).toBe(403);
    expect((await post({ origin: "https://elsewhere.example.com", "sec-fetch-site": "cross-site" })).status).toBe(403);
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "false");
    expect((await post()).status).toBe(503);
    expect(review.forgetReviewCount).not.toHaveBeenCalled();
  });
});
