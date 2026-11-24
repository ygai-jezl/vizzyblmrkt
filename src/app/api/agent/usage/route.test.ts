import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const tenant = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant", async (orig) => ({ ...(await orig<typeof import("@/lib/tenant")>()), ...tenant }));
const usage = vi.hoisted(() => ({
  organisationUsage: vi.fn(async () => ({ month: "2026-11", plan: "free", monthly: [{ feature: "web_searches", label: "Web searches for research", unit: "searches", used: 300, limit: 300, from: "plan", included: true, needs: null, byPurpose: {} }], brands: null, organisation: null })),
}));
vi.mock("@/lib/plans/usage", () => usage);

const { GET } = await import("./route");
const ctx = { tenantId: "ten_A", region: "us", source: "agent", userId: "u1" };
const get = () => new Request("http://localhost/api/agent/usage?tenantId=ten_B", { headers: { "x-canvas-context": "tok" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("USAGE_METER_ENABLED", "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(ctx);
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/usage", () => {
  it("is unavailable with the meter off, 401s a bad token, 429s past the limit", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "");
    expect((await GET(get())).status).toBe(503);
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await GET(get())).status).toBe(401);
    tenant.isRateLimited.mockResolvedValueOnce(true);
    expect((await GET(get())).status).toBe(429);
  });

  it("reads the token's brand only: a brand in the query is ignored", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(usage.organisationUsage).toHaveBeenCalledWith(ctx, {});
    const body = (await res.json()) as { thisBrand: Array<{ leftThisMonth: number }> };
    expect(body.thisBrand[0]!.leftThisMonth).toBe(0);
  });
});
