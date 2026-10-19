import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The launch email hero: off, Imagen and today's prompt (no direction); on, the brand's launch
// email style, else the hero's own pick.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenantMod = vi.hoisted(() => ({
  forTenant: vi.fn(() => ({ campaigns: { getById: vi.fn(async () => ({ id: "camp_1" })) } })),
  getTenantById: vi.fn(),
}));
vi.mock("@/lib/tenant", () => tenantMod);
const agents = vi.hoisted(() => ({
  generateHeroImage: vi.fn(async (_input: Record<string, unknown>) => ({ imageUrl: "https://x/i.png", source: "agent3" })),
}));
vi.mock("@/lib/agents", () => agents);
vi.mock("@/lib/content/create/activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));

const { POST } = await import("./route");
const req = (body: unknown) =>
  new Request("http://localhost/api/admin/email/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const last = () => agents.generateHeroImage.mock.calls.at(-1)![0];

beforeEach(() => {
  vi.clearAllMocks();
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
  tenantMod.getTenantById.mockResolvedValue({ imageStyle: { defaultStyleId: "headline_card", channels: { launchEmail: "natural_photo" } } });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/email/image", () => {
  it("off: no direction, no tenant read, the response as before", async () => {
    const res = await POST(req({ campaignId: "camp_1", brief: "Launch day", styleId: "soft_3d" }));
    expect(last()).toMatchObject({ direction: null });
    expect(tenantMod.getTenantById).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ imageUrl: "https://x/i.png", source: "agent3" });
  });

  it("on: the brand's launch email style, or the hero's own pick", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    await POST(req({ campaignId: "camp_1", brief: "Launch day" }));
    expect(last()).toMatchObject({ direction: { label: "Natural photo" } });
    const res = await POST(req({ campaignId: "camp_1", brief: "Launch day", styleId: "paper_collage" }));
    expect(last()).toMatchObject({ direction: { label: "Paper collage" } });
    expect(await res.json()).toMatchObject({ imageStyleId: "paper_collage", styleId: "paper_collage" });
  });
});
