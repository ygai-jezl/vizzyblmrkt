import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn(async () => ({ id: "ten_A", tenantName: "Acme", imageStyle: { defaultStyleId: "headline_card", accentHex: "#111111" } })) }));
vi.mock("@/lib/tenant", () => tenants);
const render = vi.hoisted(() => ({
  renderStyleImage: vi.fn(async (_r: Record<string, unknown>) => ({ png: Buffer.from("\x89PNG-bytes", "latin1"), width: 1200, height: 630 }) as { png: Buffer; width: number; height: number } | null),
}));
vi.mock("@/lib/content/imageStyle/render/styleImage", () => render);

const { GET } = await import("./route");
const get = (q: string) => GET(new Request(`http://localhost/api/admin/brand-kit/image-style/preview?${q}`));
const admin = { tenantId: "ten_A", region: "us", userId: "u", role: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET image style preview", () => {
  it("draws the template as a PNG, previewing an unsaved accent and logo choice", async () => {
    const res = await get("styleId=headline_card&accent=%237C5CFF&logo=0");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const call = render.renderStyleImage.mock.calls[0]![0] as { tenant: { imageStyle: { accentHex: string } } };
    expect(call).toMatchObject({ template: "headline_card", size: "share", showLogo: false });
    expect(call.tenant.imageStyle.accentHex).toBe("#7C5CFF");
  });

  it("only templates; a bad accent or size is ignored", async () => {
    expect((await get("styleId=soft_3d")).status).toBe(400);
    await get("styleId=product_noir&accent=red&size=huge");
    const call = render.renderStyleImage.mock.calls[0]![0] as { size: string; tenant: { imageStyle: { accentHex: string } } };
    expect(call.size).toBe("share");
    expect(call.tenant.imageStyle.accentHex).toBe("#111111");
  });

  it("admins only, switch on only, and a failed render says so", async () => {
    session.getAdminContext.mockResolvedValueOnce({ ...admin, role: "member" });
    expect((await get("styleId=headline_card")).status).toBe(403);
    render.renderStyleImage.mockResolvedValueOnce(null);
    expect((await get("styleId=headline_card")).status).toBe(502);
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "false");
    expect((await get("styleId=headline_card")).status).toBe(503);
  });
});
