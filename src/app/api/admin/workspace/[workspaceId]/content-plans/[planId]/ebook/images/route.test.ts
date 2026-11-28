import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopStamp } from "@/lib/types/loopStamp";
import type { EbookDoc } from "@/lib/types/contentPlan";

// The eBook cover as a report cover (IMAGE_FORMATS_ENABLED): drawn at 4:5, no image model.
const BOOK: EbookDoc = { title: "The state of AI search", subtitle: "What 120 teams told us", industryLens: "", tocConfirmed: true, chapters: [] } as unknown as EbookDoc;
const guard = vi.hoisted(() => ({ guardEbookRoute: vi.fn() }));
vi.mock("@/lib/content/create/ebookRoute", () => guard);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn(async () => ({ id: "ten_A", tenantName: "Acme", imageStyle: { defaultStyleId: "data_story" } })) }));
vi.mock("@/lib/tenant", () => tenants);
const store = vi.hoisted(() => ({ draft: null as EbookDoc | null }));
const content = vi.hoisted(() => ({
  mutateContentPlanEbookDraft: vi.fn(async (_c: unknown, _w: string, _p: string, fn: (d: EbookDoc) => EbookDoc) => (store.draft = fn(store.draft!))),
}));
vi.mock("@/lib/tenant/workspaceContent", () => content);
const creative = vi.hoisted(() => ({ generateEbookSlotImage: vi.fn(async () => ({ imageAssetRef: "painted.png", imagePrompt: "p" })) }));
vi.mock("@/lib/agents/creative", () => creative);
const render = vi.hoisted(() => ({ renderStyleImage: vi.fn(async (_r: Record<string, unknown>) => ({ png: Buffer.from("png"), width: 1080, height: 1350 }) as unknown) }));
vi.mock("@/lib/content/imageStyle/render/styleImage", () => render);
const assets = vi.hoisted(() => ({ storeWorkspaceImage: vi.fn(async () => ({ ok: true, filename: "cover.png" })), deleteWorkspaceAsset: vi.fn(async () => {}) }));
vi.mock("@/lib/workspace/assetStore", () => assets);
const kit = vi.hoisted(() => ({
  recordImageAsset: vi.fn(async () => ({ id: "a1" })),
  deleteImageAsset: vi.fn(async () => {}),
  newImageAssetId: vi.fn(() => "img-ebook-1"),
}));
vi.mock("@/lib/admin/brandKit", () => kit);
// The learning loops' reader, remakes and counts (step 4), watched; the image style tests below set what they read.
vi.mock("@/lib/loops/read", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/loops/read")>();
  return { ...real, learnedFor: vi.fn(real.learnedFor) };
});
vi.mock("@/lib/loops/remake", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/loops/remake")>();
  return { ...real, readRemake: vi.fn(real.readRemake), recordRemake: vi.fn(async () => true) };
});
vi.mock("@/lib/loops/count", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/loops/count")>();
  return { ...real, countMade: vi.fn(async () => undefined) };
});
const loopsRead = await import("@/lib/loops/read");
const loopsRemake = await import("@/lib/loops/remake");
const loopsCount = await import("@/lib/loops/count");

const { POST } = await import("./route");
const params = { params: Promise.resolve({ workspaceId: "ws1", planId: "p1" }) };
const req = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  store.draft = { ...BOOK };
  guard.guardEbookRoute.mockResolvedValue({ ok: { ctx: { tenantId: "ten_A", region: "us" }, ws: { id: "ws1" }, plan: { ebookDraft: store.draft } } });
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_FORMATS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST eBook cover as a report cover", () => {
  it("draws it from the eBook's title in the brand's style, at 4:5, with no image model", async () => {
    const res = await POST(req({ target: { kind: "cover" }, aspect: "4:5", format: "report_cover", formatInputs: { figure: { value: "120", unit: "teams" } } }), params);
    expect(res.status).toBe(200);
    expect(render.renderStyleImage.mock.calls[0]![0]).toMatchObject({
      template: "report_cover",
      size: "portrait",
      skin: "data_story",
      formatInputs: { title: "The state of AI search", subtitle: "What 120 teams told us", figure: { value: "120", unit: "teams" } },
    });
    expect(creative.generateEbookSlotImage).not.toHaveBeenCalled();
    expect(store.draft!.coverImage).toMatchObject({ imageAssetRef: "cover.png", aspect: "4:5", format: "report_cover" });
  });

  it("with the formats switch off, the cover is painted as before", async () => {
    vi.stubEnv("IMAGE_FORMATS_ENABLED", "false");
    await POST(req({ target: { kind: "cover" }, aspect: "1:1", brief: "A bold cover", format: "report_cover" }), params);
    expect(render.renderStyleImage).not.toHaveBeenCalled();
    expect(creative.generateEbookSlotImage).toHaveBeenCalled();
  });
});

describe("POST eBook image with image style versions on (learning loops step 4)", () => {
  const CHAPTER = { id: "c1", title: "One", bodyHtml: "<p>Sourdough at dawn.</p>", images: [{ id: "s1", aspect: "1:1", imageAssetRef: "earlier.png" }] };
  const stamp: LoopStamp = {
    made: "m1.image_style.natural_photo.1.l",
    kind: "ebook_image",
    scope: "image_style.natural_photo",
    v: 1,
    arm: "learned",
    items: ["look1"],
    prompt: null,
    tokens: { rules: 20, examples: 0 },
    at: "2027-01-15T10:00:00.000Z",
  };
  const noRemake = { kind: "ebook_image" as const, earlier: null, counts: false, purpose: "ebook_image" as const };
  beforeEach(() => {
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    store.draft = { ...BOOK, chapters: [CHAPTER] } as unknown as EbookDoc;
    guard.guardEbookRoute.mockResolvedValue({ ok: { ctx: { tenantId: "ten_A", region: "us" }, ws: { id: "ws1" }, plan: { ebookDraft: store.draft } } });
    vi.mocked(loopsRemake.readRemake).mockResolvedValue(noRemake);
    vi.mocked(loopsRead.learnedFor).mockResolvedValue({ block: { look: "Warm daylight on flour.", holdback: false }, stamp });
  });

  it("a new slot image reads the look with the id minted first, and is counted and checked for a remake once saved", async () => {
    creative.generateEbookSlotImage.mockResolvedValueOnce({ imageAssetRef: "painted.png", imagePrompt: "p", made: stamp } as never);
    const res = await POST(req({ target: { kind: "slot", chapterId: "c1", slotId: "s1" }, aspect: "1:1", brief: "A loaf", styleId: "natural_photo" }), params);
    expect(res.status).toBe(200);
    expect(loopsRemake.readRemake).toHaveBeenCalledWith(expect.anything(), "ebook_image", "earlier.png");
    expect(vi.mocked(loopsRead.learnedFor).mock.calls.at(-1)![2]).toMatchObject({ scope: "image_style.natural_photo", outputId: "img-ebook-1" });
    expect((creative.generateEbookSlotImage.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0]).toMatchObject({
      assetId: "img-ebook-1",
      learning: { made: stamp, lookUsed: true, holdback: false, notLearning: false },
    });
    expect(loopsCount.countMade).toHaveBeenCalledWith(expect.anything(), "ebook_image", stamp, { type: "image_asset" });
    expect(loopsRemake.recordRemake).toHaveBeenCalledWith(expect.anything(), noRemake, "img-ebook-1");
  });

  it("an edit is never held back and never learns", async () => {
    await POST(req({ target: { kind: "slot", chapterId: "c1", slotId: "s1" }, aspect: "1:1", mode: "edit", instruction: "warmer light" }), params);
    expect(vi.mocked(loopsRead.learnedFor).mock.calls.at(-1)![2]).not.toHaveProperty("outputId");
    expect((creative.generateEbookSlotImage.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0]).toMatchObject({ learning: { notLearning: true } });
  });

  it("the drawn report cover is stamped arm none in its style's scope, and counted", async () => {
    const res = await POST(req({ target: { kind: "cover" }, aspect: "4:5", format: "report_cover" }), params);
    expect(res.status).toBe(200);
    expect(kit.recordImageAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "img-ebook-1", made: expect.objectContaining({ kind: "ebook_image", scope: "image_style.data_story", v: 0, arm: "none" }) }),
    );
    expect(loopsCount.countMade).toHaveBeenCalledWith(expect.anything(), "ebook_image", expect.objectContaining({ arm: "none" }), { type: "image_asset" });
  });
});
