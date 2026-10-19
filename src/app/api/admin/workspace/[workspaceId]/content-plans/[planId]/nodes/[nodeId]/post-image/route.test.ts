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
const brandAssets = vi.hoisted(() => ({ countBrandAssetsUpTo: vi.fn(async () => 0) }));
vi.mock("@/lib/admin/brandAssets", () => brandAssets);
const render = vi.hoisted(() => ({
  renderStyleImage: vi.fn(async (_r: Record<string, unknown>) => ({ png: Buffer.from("png"), width: 1080, height: 1080 }) as { png: Buffer; width: number; height: number } | null),
  templateFor: (id: string) => (["product_noir", "headline_card", "data_story", "type_poster", "split_card", "line_art"].includes(id) ? id : null),
  formatTemplate: (f?: string) => (f === "portrait" || f === "partner" || f === "report_cover" ? f : null),
}));
const numbers = vi.hoisted(() => ({
  chartFromCopy: vi.fn(async (_c: { text: string }) => null as unknown),
  figureFromCopy: vi.fn((_c: { text: string }) => null as unknown),
}));
vi.mock("@/lib/content/imageStyle/chartFromCopy", () => numbers);
const scene = vi.hoisted(() => ({ paintFormatScene: vi.fn(async (_r: Record<string, unknown>) => ({ bytes: Buffer.from("scene"), mimeType: "image/png" }) as unknown) }));
vi.mock("@/lib/content/imageStyle/formatScene", () => scene);
vi.mock("@/lib/content/imageStyle/render/styleImage", () => render);
const store = vi.hoisted(() => ({ storeWorkspaceImage: vi.fn(async () => ({ ok: true, filename: "drawn.png" })) }));
vi.mock("@/lib/workspace/assetStore", () => store);
const kit = vi.hoisted(() => ({ recordImageAsset: vi.fn(async (_s: unknown, _row: Record<string, unknown>) => ({})) }));
vi.mock("@/lib/admin/brandKit", () => kit);

const { POST } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const plan = { graph: { nodes: [{ id: "n1", channel: "linkedin", body: "<p>We cut onboarding to five minutes. Here's how. #growth</p>" }] } };
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

  it("a style built from product screens asks for them first, unless made without one", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    const res = await POST(req({ brief: "A desk", aspect: "1:1", styleId: "product_noir" }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "needs_screenshots" });
    expect(creative.generateSocialPostImage).not.toHaveBeenCalled();

    const without = await POST(req({ brief: "A desk", aspect: "1:1", styleId: "product_noir", withoutScreenshot: true }), params);
    expect(without.status).toBe(200);
    brandAssets.countBrandAssetsUpTo.mockResolvedValueOnce(2);
    expect((await POST(req({ brief: "A desk", aspect: "1:1", styleId: "product_noir" }), params)).status).toBe(200);
    // A model style never asks.
    expect((await POST(req({ brief: "A desk", aspect: "1:1", styleId: "soft_3d" }), params)).status).toBe(200);
  });

  it("refuses a style id that's too long", async () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    const res = await POST(req({ brief: "A desk", aspect: "1:1", styleId: "x".repeat(41) }), params);
    expect(res.status).toBe(400);
  });

  describe("template styles are drawn, not painted", () => {
    beforeEach(() => vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true"));
    const lastRender = () => render.renderStyleImage.mock.calls.at(-1)![0];

    it("draws the post's first line in the brand's Headline card, with no brief needed", async () => {
      tenantMod.getTenantById.mockResolvedValueOnce({ imageStyle: { defaultStyleId: "headline_card" } });
      const res = await POST(req({ aspect: "4:5", styleId: "brand" }), params);
      expect(res.status).toBe(200);
      expect(lastRender()).toMatchObject({ template: "headline_card", size: "portrait", headline: "We cut onboarding to five minutes.", showLogo: true });
      expect(creative.generateSocialPostImage).not.toHaveBeenCalled();
      expect(lastPatch()).toMatchObject({ imageAssetRef: "drawn.png", imagePrompt: null, imageStyleId: null, imageHeadline: null });
      expect(kit.recordImageAsset.mock.calls[0]![1]).toMatchObject({ kind: "social", style: "headline_card" });
    });

    it("the person's own words are used and kept with the post", async () => {
      await POST(req({ aspect: "1:1", styleId: "product_noir", headline: "Five *minutes* to value", withoutScreenshot: true }), params);
      expect(lastRender()).toMatchObject({ template: "product_noir", size: "square", headline: "Five *minutes* to value" });
      expect(lastPatch()).toMatchObject({ imageStyleId: "product_noir", imageHeadline: "Five *minutes* to value" });
    });

    it("a failed render still makes an image, painted in the style's twin", async () => {
      render.renderStyleImage.mockResolvedValueOnce(null);
      const res = await POST(req({ brief: "A desk", aspect: "1:1", styleId: "headline_card" }), params);
      expect(res.status).toBe(200);
      expect(lastCall()).toMatchObject({ style: "illustration" });
    });

    it("without a brief, a painted style asks for one", async () => {
      const res = await POST(req({ aspect: "1:1", styleId: "soft_3d" }), params);
      expect(res.status).toBe(400);
      expect(creative.generateSocialPostImage).not.toHaveBeenCalled();
    });
  });

  describe("type over painted art", () => {
    beforeEach(() => vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true"));

    it("lays the headline and logo over the art when the brand asked for them", async () => {
      await POST(req({ brief: "A desk", aspect: "1.91:1", styleId: "soft_3d" }), params);
      const finish = lastCall().finish as (img: { bytes: Buffer; mimeType: string }) => Promise<{ bytes: Buffer; mimeType: string }>;
      const out = await finish({ bytes: Buffer.from("art"), mimeType: "image/jpeg" });
      expect(render.renderStyleImage.mock.calls[0]![0]).toMatchObject({
        template: "art_overlay",
        size: "landscape",
        headline: "We cut onboarding to five minutes.",
        art: Buffer.from("art"),
        showHeadline: true,
        showLogo: true,
      });
      expect(out.mimeType).toBe("image/png");
    });

    it("not when both are switched off, nor before the brand saved a style", async () => {
      tenantMod.getTenantById.mockResolvedValueOnce({ imageStyle: { defaultStyleId: "soft_3d", headlineOnSocial: false, logoOnSocial: false } });
      await POST(req({ brief: "A desk", aspect: "1:1", styleId: "brand" }), params);
      expect(lastCall()).not.toHaveProperty("finish");
      tenantMod.getTenantById.mockResolvedValueOnce({});
      await POST(req({ brief: "A desk", aspect: "1:1", styleId: "soft_3d" }), params);
      expect(lastCall()).not.toHaveProperty("finish");
    });
  });

  describe("v2 drawn styles (BRAND_IMAGE_STYLE_MORE_ENABLED)", () => {
    beforeEach(() => {
      vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
      vi.stubEnv("BRAND_IMAGE_STYLE_MORE_ENABLED", "true");
    });
    const lastRender = () => render.renderStyleImage.mock.calls.at(-1)![0];
    const CHART = { kind: "line", unit: "%", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] };

    it("Data story charts the post's checked numbers, and keeps them with the post", async () => {
      numbers.chartFromCopy.mockResolvedValueOnce(CHART);
      const res = await POST(req({ aspect: "1:1", styleId: "data_story" }), params);
      expect(res.status).toBe(200);
      expect(numbers.chartFromCopy.mock.calls[0]![0].text).toContain("five minutes");
      expect(lastRender()).toMatchObject({ template: "data_story", chart: CHART });
      expect(lastPatch()).toMatchObject({ imageChart: CHART, imageStyleId: "data_story" });
      expect(await res.json()).toMatchObject({ chart: CHART, styleId: "data_story" });
    });

    it("too few numbers asks the person; their own numbers are drawn as given", async () => {
      const asked = await POST(req({ aspect: "1:1", styleId: "data_story" }), params);
      expect(asked.status).toBe(409);
      expect(await asked.json()).toMatchObject({ error: "needs_numbers" });
      expect(render.renderStyleImage).not.toHaveBeenCalled();
      const own = { ...CHART, points: [{ label: "Q1", value: 3 }, { label: "Q2", value: 9 }] };
      await POST(req({ aspect: "1:1", styleId: "data_story", chart: own }), params);
      expect(numbers.chartFromCopy).toHaveBeenCalledTimes(1);
      expect(lastRender()).toMatchObject({ chart: own });
    });

    it("Type poster takes the person's number, else the post's; Line art draws anew each attempt", async () => {
      numbers.figureFromCopy.mockReturnValueOnce({ value: "5", unit: "minutes" });
      await POST(req({ aspect: "4:5", styleId: "type_poster" }), params);
      expect(lastRender()).toMatchObject({ template: "type_poster", figure: { value: "5", unit: "minutes" } });
      await POST(req({ aspect: "4:5", styleId: "type_poster", figure: { value: "120", unit: "teams" } }), params);
      expect(lastRender()).toMatchObject({ figure: { value: "120", unit: "teams" } });
      expect(lastPatch()).toMatchObject({ imageFormatInputs: { figure: { value: "120", unit: "teams" } } });

      await POST(req({ aspect: "1:1", styleId: "line_art" }), params);
      const first = lastRender().seed;
      await POST(req({ aspect: "1:1", styleId: "line_art", attempt: 1 }), params);
      expect(lastRender()).toMatchObject({ template: "line_art" });
      expect(lastRender().seed).not.toBe(first);
    });

    it("Split card paints its photo first, then draws the card around it; without art, the panel alone", async () => {
      await POST(req({ aspect: "1.91:1", styleId: "split_card" }), params);
      expect(lastCall()).toMatchObject({ style: "split_card", brief: "We cut onboarding to five minutes." });
      const finish = lastCall().finish as (img: { bytes: Buffer; mimeType: string }) => Promise<{ mimeType: string }>;
      await finish({ bytes: Buffer.from("photo"), mimeType: "image/png" });
      expect(lastRender()).toMatchObject({ template: "split_card", art: Buffer.from("photo"), size: "landscape" });

      creative.generateSocialPostImage.mockResolvedValueOnce({ imageAssetRef: null, imagePrompt: null, source: "unavailable", reason: "image_model_unavailable" } as never);
      const res = await POST(req({ aspect: "1:1", styleId: "split_card" }), params);
      expect(res.status).toBe(200);
      expect(lastRender()).toMatchObject({ template: "split_card" });
      expect(lastRender()).not.toHaveProperty("art");
    });

    it("with the v2 switch off, the four fall back to v1 looks", async () => {
      vi.stubEnv("BRAND_IMAGE_STYLE_MORE_ENABLED", "false");
      await POST(req({ aspect: "1:1", styleId: "type_poster" }), params);
      expect(lastRender()).toMatchObject({ template: "headline_card" });
      expect(numbers.figureFromCopy).not.toHaveBeenCalled();
    });
  });

  describe("formats (IMAGE_FORMATS_ENABLED)", () => {
    beforeEach(() => {
      vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
      vi.stubEnv("IMAGE_FORMATS_ENABLED", "true");
    });
    const lastRender = () => render.renderStyleImage.mock.calls.at(-1)![0];

    it("a portrait card paints a scene for the quote and draws the card in the post's style", async () => {
      const inputs = { quote: "Ship small, ship often.", name: "Sam", role: "Founder" };
      const res = await POST(req({ aspect: "1:1", styleId: "soft_3d", format: "portrait", formatInputs: inputs }), params);
      expect(res.status).toBe(200);
      expect(scene.paintFormatScene.mock.calls[0]![0]).toMatchObject({ format: "portrait", inputs, direction: { label: "Soft 3D" }, aspectRatio: "1:1" });
      expect(lastRender()).toMatchObject({ template: "portrait", skin: "soft_3d", formatInputs: inputs, art: Buffer.from("scene") });
      expect(lastPatch()).toMatchObject({ imageFormat: "portrait", imageFormatInputs: inputs, imageStyleId: "soft_3d" });
      expect(creative.generateSocialPostImage).not.toHaveBeenCalled();
    });

    it("needs a quote or a partner's name; a report cover in a drawn style paints nothing", async () => {
      expect((await POST(req({ aspect: "1:1", format: "portrait", formatInputs: {} }), params)).status).toBe(400);
      expect((await POST(req({ aspect: "1:1", format: "partner", formatInputs: { line: "x" } }), params)).status).toBe(400);
      await POST(req({ aspect: "4:5", styleId: "headline_card", format: "report_cover", formatInputs: { title: "T" } }), params);
      expect(scene.paintFormatScene).not.toHaveBeenCalled();
      expect(lastRender()).toMatchObject({ template: "report_cover", skin: "headline_card", size: "portrait" });
      expect(lastRender()).not.toHaveProperty("art");
    });

    it("a failed paint still draws the card; with the switch off, the format is ignored", async () => {
      scene.paintFormatScene.mockResolvedValueOnce(null);
      await POST(req({ aspect: "1:1", format: "partner", formatInputs: { partner: "Example" } }), params);
      expect(lastRender()).toMatchObject({ template: "partner", formatInputs: { partner: "Example" } });
      expect(lastRender()).not.toHaveProperty("art");
      vi.stubEnv("IMAGE_FORMATS_ENABLED", "false");
      render.renderStyleImage.mockClear();
      await POST(req({ brief: "A desk", aspect: "1:1", styleId: "soft_3d", format: "partner", formatInputs: { partner: "Example" } }), params);
      expect(render.renderStyleImage).not.toHaveBeenCalledWith(expect.objectContaining({ template: "partner" }));
      expect(creative.generateSocialPostImage).toHaveBeenCalled();
    });
  });
});
