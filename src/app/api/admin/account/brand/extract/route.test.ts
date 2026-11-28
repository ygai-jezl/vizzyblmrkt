import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Account › Brand's guidelines PDF extract: the route stores the kit it reads, so it counts it made
// and kept there and hands back no stamp token for a save that may never come (learning loops
// step 5, decision 20). Hearth Bakery is made up.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
vi.mock("@/lib/http/sameOrigin", () => ({ sameOriginGuard: () => null }));
vi.mock("@/lib/tenant", () => ({ getTenantById: vi.fn(async () => ({ brandKit: { summary: "Warm and floury" } })) }));
const control = vi.hoisted(() => ({
  updateTenantConfig: vi.fn(async () => undefined),
  withPreservedLearnedStyle: vi.fn((kit: Record<string, unknown>) => ({ ...kit })),
}));
vi.mock("@/lib/tenant/control", () => control);
vi.mock("@/lib/tenant/brandAsset", () => ({ readBrandPdf: vi.fn(async () => Buffer.from("%PDF-1.4")) }));
vi.mock("@/lib/agents/prompts/registry", () => ({ renderPrompt: () => "Read the brand kit." }));
vi.mock("@/lib/agents/gemini", () => ({
  generateTextWithFile: vi.fn(async () => JSON.stringify({ summary: "Warm and floury", tone: "Friendly", palette: [{ hex: "#8a5a2b", name: "Crust" }] })),
  parseFirstJson: (raw: string) => JSON.parse(raw),
}));
vi.mock("@/lib/plans/meter", () => ({ aiUsage: () => ({}) }));
const counts = vi.hoisted(() => ({ countMadeKept: vi.fn(async () => undefined) }));
vi.mock("@/lib/loops/count", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/loops/count")>()), ...counts }));
const hand = vi.hoisted(() => ({ handBack: vi.fn(async () => "st1.a.b") }));
vi.mock("@/lib/loops/handBack", () => hand);

const { POST } = await import("./route");

const admin = { tenantId: "ten_hearth", region: "eu", source: "idtoken", userId: "usr_maya", role: "admin" };
const post = () =>
  POST(new Request("http://localhost/api/admin/account/brand/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pdfPath: "guidelines.pdf", pdfName: "Hearth guidelines" }) }));

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/account/brand/extract", () => {
  it("stores the kit and counts it made and kept at once, with no stamp token back", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("stampToken");
    expect(body.brandKit).toMatchObject({ summary: "Warm and floury", tone: "Friendly", pdfPath: "guidelines.pdf" });
    expect(control.updateTenantConfig).toHaveBeenCalledWith("ten_hearth", { brandKit: expect.objectContaining({ tone: "Friendly" }) });
    expect(counts.countMadeKept).toHaveBeenCalledTimes(1);
    expect(counts.countMadeKept).toHaveBeenCalledWith(admin, "brand_kit", expect.objectContaining({ kind: "brand_kit", scope: "brand_kit", arm: "none" }));
    expect(hand.handBack).not.toHaveBeenCalled();
  });

  it("counts nothing with LOOPS_ENABLED off, and answers as before", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as Record<string, unknown>)).toEqual(["brandKit"]);
    expect(counts.countMadeKept).not.toHaveBeenCalled();
    expect(hand.handBack).not.toHaveBeenCalled();
  });
});
