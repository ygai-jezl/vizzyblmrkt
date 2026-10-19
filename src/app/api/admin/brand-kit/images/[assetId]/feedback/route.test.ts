import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A vote teaches the brand's one look as before, and (image style on) the image's own style.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const kit = vi.hoisted(() => ({ setImageBrandVote: vi.fn() }));
vi.mock("@/lib/admin/brandKit", () => kit);
const profile = vi.hoisted(() => ({
  refreshExemplarStyle: vi.fn(async () => undefined),
  refreshLearnedImageStyle: vi.fn(async () => undefined),
  refreshLearnedStyleBucket: vi.fn(async () => undefined),
}));
vi.mock("@/lib/content/create/styleProfile", () => profile);

const { POST } = await import("./route");
const params = { params: Promise.resolve({ assetId: "img_1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_KIT_ENABLED", "true");
  session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", userId: "u", role: "admin" });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST image feedback", () => {
  it("off: only the brand's one look learns", async () => {
    kit.setImageBrandVote.mockResolvedValue({ id: "img_1", style: "soft_3d" });
    await POST(req({ vote: "up", rating: 9 }), params);
    expect(profile.refreshExemplarStyle).toHaveBeenCalled();
    expect(profile.refreshLearnedStyleBucket).not.toHaveBeenCalled();
  });

  it("on: the image's style learns too (old presets by the style they map to; templates never)", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    kit.setImageBrandVote.mockResolvedValue({ id: "img_1", style: "earthy" });
    await POST(req({ vote: "down" }), params);
    expect(profile.refreshLearnedImageStyle).toHaveBeenCalled();
    expect(profile.refreshLearnedStyleBucket).toHaveBeenCalledWith(expect.anything(), "natural_photo");

    vi.clearAllMocks();
    kit.setImageBrandVote.mockResolvedValue({ id: "img_2", style: "headline_card" });
    await POST(req({ vote: "up", rating: 8 }), params);
    expect(profile.refreshLearnedStyleBucket).not.toHaveBeenCalled();
  });
});
