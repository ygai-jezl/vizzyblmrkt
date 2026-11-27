import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Colours page's save (Brand Kit › Colours): only the palette zones, and the stamp tokens of
// colours kept from a source, checked at the save (learning loops step 5, decision 20). Hearth
// Bakery is made up.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
vi.mock("@/lib/tenant", () => ({ getTenantById: vi.fn(async () => ({ brandKit: { summary: "Warm and floury" } })) }));
const control = vi.hoisted(() => ({ updateTenantConfig: vi.fn(async () => undefined) }));
vi.mock("@/lib/tenant/control", () => control);
const hand = vi.hoisted(() => ({ keptFromTokens: vi.fn(async () => []) }));
vi.mock("@/lib/loops/handBack", () => hand);

const { PUT } = await import("./route");

const admin = { tenantId: "ten_hearth", region: "eu", source: "idtoken", userId: "usr_maya", role: "admin" };
const put = (body: unknown, headers: Record<string, string> = {}) =>
  PUT(new Request("http://localhost/api/admin/brand-kit/colours", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_COLORS_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("PUT /api/admin/brand-kit/colours", () => {
  it("saves the palette zones, keeps the rest of the kit, and counts the tokens of kept colours kept as brand kit stamps", async () => {
    const palette = [{ hex: "#AA5500", name: "Crust" }];
    const res = await put({ palette }, { "x-stamp-tokens": "st1.a.b,st1.c.d" });
    expect(res.status).toBe(200);
    expect(control.updateTenantConfig).toHaveBeenCalledWith("ten_hearth", { brandKit: expect.objectContaining({ summary: "Warm and floury", palette }) });
    expect(hand.keptFromTokens).toHaveBeenCalledWith(admin, ["brand_kit"], ["st1.a.b", "st1.c.d"]);
  });

  it("checks no tokens when it saves nothing", async () => {
    expect((await put({ palette: "red" })).status).toBe(400);
    vi.stubEnv("BRAND_COLORS_ENABLED", "false");
    expect((await put({ palette: [] })).status).toBe(503);
    expect(hand.keptFromTokens).not.toHaveBeenCalled();
    expect(control.updateTenantConfig).not.toHaveBeenCalled();
  });
});
