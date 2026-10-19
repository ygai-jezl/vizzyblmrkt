import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The social post image: with the image style off, exactly today's inputs; on, the post's own
// pick, then the brand's channel style, then its default, saved with the post.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenantMod = vi.hoisted(() => ({
  forTenant: vi.fn(() => ({ workspaces: { getById: vi.fn(async () => ({ id: "ws_1", brandVoice: null, audience: null })) } })),
  getTenantById: vi.fn(),
}));
vi.mock("@/lib/tenant", () => tenantMod);
const content = vi.hoisted(() => ({
  getContentPlan: vi.fn(),
  updateContentPlanNode: vi.fn(async (_c: unknown, _w: string, _p: string, _n: string, patch: Record<string, unknown>) => ({ ...patch })),
}));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const creative = vi.hoisted(() => ({
  generateSocialPostImage: vi.fn(async (_input: Record<string, unknown>) => ({ imageAssetRef: "img.png", imagePrompt: "p", source: "agent3" })),
}));
vi.mock("@/lib/agents/creative", () => creative);

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const plan = { graph: { nodes: [{ id: "n1", channel: "linkedin", body: "<p>Hello</p>" }] } };
const params = { params: Promise.resolve({ workspaceId: "ws_1", planId: "p1", nodeId: "n1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const lastCall = () => creative.generateSocialPostImage.mock.calls.at(-1)![0];
const lastPatch = () => content.updateContentPlanNode.mock.calls.at(-1)![4] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CREATE_SOCIAL_IMAGE_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  content.getContentPlan.mockResolvedValue(plan);
  tenantMod.getTenantById.mockResolvedValue({
    imageStyle: { defaultStyleId: "illustration", channels: { linkedin: "natural_photo" } },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("POST post-image", () => {
  it("image style off: the old preset, no direction, nothing new saved", async () => {
    const res = await POST(req({ brief: "A desk", aspect: "1:1", style: "retro", styleId: "soft_3d" }), params);
    expect(res.status).toBe(200);
    expect(lastCall()).toMatchObject({ style: "retro", direction: null });
    expect(lastPatch()).not.toHaveProperty("imageStyleId");
    expect(await res.json()).toEqual({ imageAssetRef: "img.png", imagePrompt: "p" });
  });

  it("image style on: the brand's channel style, saved as the brand's (null)", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    const res = await POST(req({ brief: "A desk", aspect: "1:1", styleId: "brand" }), params);
    expect(lastCall()).toMatchObject({ style: "natural_photo", direction: { label: "Natural photo" } });
    expect((lastCall().direction as { keywords: string }).keywords).toContain("daylight");
    expect(lastPatch()).toMatchObject({ imageStyleId: null });
    expect(await res.json()).toMatchObject({ imageStyleId: null, styleId: "natural_photo" });
  });

  it("this post's own pick wins and is saved with the post", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    await POST(req({ brief: "A desk", aspect: "1:1", styleId: "soft_3d" }), params);
    expect(lastCall()).toMatchObject({ style: "soft_3d", direction: { label: "Soft 3D" } });
    expect(lastPatch()).toMatchObject({ imageStyleId: "soft_3d" });
  });

  it("an old preset picked for one post is still that old look", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    await POST(req({ brief: "A desk", aspect: "1:1", styleId: "popart" }), params);
    expect(lastCall()).toMatchObject({ style: "popart", direction: null });
    expect(lastPatch()).toMatchObject({ imageStyleId: "popart" });
  });

  it("before a brand picks, today's default preset", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    tenantMod.getTenantById.mockResolvedValue({});
    await POST(req({ brief: "A desk", aspect: "1:1", styleId: "brand" }), params);
    expect(lastCall()).toMatchObject({ style: "cinematic", direction: null });
  });

  it("learning per style: the style's own learned look, and references from that style only", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    tenantMod.getTenantById.mockResolvedValue({
      brandKit: { learnedImageStyle: "Global look." },
      imageStyle: {
        defaultStyleId: "soft_3d",
        learned: { soft_3d: { directive: "Pastel ground, one object.", sampleCount: 3, updatedAt: "t" } },
      },
    });
    await POST(req({ brief: "A desk", aspect: "1:1", styleId: "brand" }), params);
    expect(lastCall()).toMatchObject({ style: "soft_3d", learningStyleId: "soft_3d" });
    expect(lastCall().brandContext).toContain("Pastel ground, one object.");
    expect(lastCall().brandContext).not.toContain("Global look.");
    // Off: the brand's one learned look, and no style filter on references.
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "");
    await POST(req({ brief: "A desk", aspect: "1:1", style: "retro" }), params);
    expect(lastCall()).not.toHaveProperty("learningStyleId");
    expect(lastCall().brandContext).toContain("Global look.");
  });

  it("refuses a style id that's too long", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    const res = await POST(req({ brief: "A desk", aspect: "1:1", styleId: "x".repeat(41) }), params);
    expect(res.status).toBe(400);
  });
});
