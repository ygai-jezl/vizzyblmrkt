import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopStamp } from "@/lib/types/loopStamp";

// The holdback in the image paths (learning loops step 4, decision 3): a held back image leaves
// out only what was learned (the look, which its caller kept out of the brand context, and the
// style references picked from votes). The brand's own icons and graphics, the model path those
// references would take, and best of N all stay, so the two arms differ only by what was learned.
vi.mock("./gemini", () => ({
  generateText: vi.fn(async () => "an expanded image prompt"),
  generateBlockImage: vi.fn(async () => ({ bytes: Buffer.from("lite"), mimeType: "image/png" })),
  generateEbookImage: vi.fn(async () => ({ bytes: Buffer.from("full"), mimeType: "image/png" })),
  generateImage: vi.fn(),
  NO_USAGE: { check: async () => null, recordModel: async () => {}, recordSearches: async () => {}, recordImages: async () => {} },
  isUsageLimited: (r: unknown) => typeof r === "object" && r !== null && (r as { limited?: unknown }).limited === true,
}));
const refs = vi.hoisted(() => ({
  style: [{ base64: "liked-1", mimeType: "image/png" }, { base64: "liked-2", mimeType: "image/png" }],
  assets: [{ base64: "brand-icon", mimeType: "image/png" }],
}));
vi.mock("@/lib/content/create/exemplarImages", () => ({
  retrieveExemplarImages: vi.fn(async () => refs.style),
  STYLE_REF_DIRECTIVE: "STYLE REFS",
}));
vi.mock("@/lib/content/create/brandAssetRefs", () => ({
  retrieveBrandAssetRefs: vi.fn(async () => refs.assets),
  BRAND_ASSET_REF_DIRECTIVE: "BRAND ASSETS",
}));
vi.mock("@/lib/content/create/brandStyleLoop", () => ({ isBestOfNEnabled: () => true, bestOfNCount: () => 3 }));
vi.mock("@/lib/content/create/bestOfN", () => ({
  generateBestOfN: vi.fn(async (i: { generate: () => Promise<unknown> }) => i.generate()),
}));
vi.mock("@/lib/workspace/assetStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/assetStore")>()),
  storeWorkspaceImage: vi.fn(async () => ({ ok: true, filename: "img.png" })),
  readWorkspaceAsset: vi.fn(async () => ({ bytes: Buffer.from("prior"), contentType: "image/png" })),
}));
vi.mock("./imageStore", () => ({ storeEmailImage: vi.fn(async () => ({ ok: true, path: "ten_hearth/camp/hero.png" })) }));
vi.mock("@/lib/admin/brandKit", () => ({
  recordImageAsset: vi.fn(async (_scope: unknown, input: { id?: string }) => ({ id: input.id ?? "minted", ...input })),
}));
vi.mock("@/lib/loops/count", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loops/count")>()),
  countLostStamp: vi.fn(async () => {}),
}));

const { generateSocialPostImage, generateEbookSlotImage, generateHeroImage } = await import("./creative");
const { generateBlockImage, generateEbookImage, generateText, NO_USAGE } = await import("./gemini");
const { generateBestOfN } = await import("@/lib/content/create/bestOfN");
const { recordImageAsset } = await import("@/lib/admin/brandKit");
const { countLostStamp } = await import("@/lib/loops/count");

const stampOn = (arm: "learned" | "holdback"): LoopStamp => ({
  made: `m1.image_style.natural_photo.2.${arm === "learned" ? "l" : "h"}`,
  kind: "post_image",
  scope: "image_style.natural_photo",
  v: 2,
  arm,
  items: arm === "learned" ? ["look2"] : [],
  prompt: null,
  tokens: { rules: arm === "learned" ? 22 : 0, examples: 0 },
  at: "2027-01-15T10:00:00.000Z",
});

const social = (holdback: boolean) => ({
  tenantId: "ten_hearth",
  workspaceId: "ws_hearth",
  channel: "linkedin",
  brief: "Saturday loaves cooling on the rack",
  aspect: "1:1" as const,
  style: "natural_photo",
  learningStyleId: "natural_photo",
  brandContext: holdback ? "Brand context without the look" : "Brand context with the look",
  region: "us" as const,
  assetId: "img-hearth-1",
  usage: NO_USAGE,
  learning: { made: stampOn(holdback ? "holdback" : "learned"), lookUsed: !holdback, holdback },
});

const recorded = () => vi.mocked(recordImageAsset).mock.calls.at(-1)![1] as { id?: string; made: LoopStamp };

beforeEach(() => {
  vi.clearAllMocks();
  refs.style = [{ base64: "liked-1", mimeType: "image/png" }, { base64: "liked-2", mimeType: "image/png" }];
  refs.assets = [{ base64: "brand-icon", mimeType: "image/png" }];
});

describe("a post image, learned and held back", () => {
  it("learned: the liked references and the brand's own go with the prompt, with best of N, stamped learned", async () => {
    const r = await generateSocialPostImage(social(false));
    expect(vi.mocked(generateEbookImage).mock.calls[0]![0]).toMatchObject({ styleRefImages: [...refs.style, ...refs.assets] });
    expect(generateBestOfN).toHaveBeenCalledWith(expect.objectContaining({ n: 3, styleReference: "Brand context with the look" }));
    expect(recorded()).toMatchObject({ id: "img-hearth-1", made: { arm: "learned", sources: ["refs:2", "best_of:3"], items: ["look2"] } });
    expect(r.made).toEqual(recorded().made);
  });

  it("held back: only the liked references stay out; the brand's own, the model path and best of N stay", async () => {
    const r = await generateSocialPostImage(social(true));
    const call = vi.mocked(generateEbookImage).mock.calls[0]![0];
    expect(call.styleRefImages).toEqual(refs.assets);
    expect(call.model).toBeUndefined();
    expect(call.prompt).toContain("BRAND ASSETS");
    expect(call.prompt).not.toContain("STYLE REFS");
    expect(generateBlockImage).not.toHaveBeenCalled();
    expect(generateBestOfN).toHaveBeenCalledWith(expect.objectContaining({ n: 3, styleReference: "Brand context without the look" }));
    expect(recorded()).toMatchObject({ id: "img-hearth-1", made: { arm: "holdback", sources: ["best_of:3"], items: [] } });
    expect(r.made).toMatchObject({ arm: "holdback" });
  });

  it("held back with no icons or graphics: still the full model path the liked references would take", async () => {
    refs.assets = [];
    await generateSocialPostImage(social(true));
    const call = vi.mocked(generateEbookImage).mock.calls[0]![0];
    expect(call.styleRefImages).toEqual([]);
    expect(call.prompt).toBe("an expanded image prompt");
    expect(generateBlockImage).not.toHaveBeenCalled();
  });

  it("with no references at all, both arms stay on the lite model", async () => {
    refs.style = [];
    refs.assets = [];
    await generateSocialPostImage(social(true));
    await generateSocialPostImage(social(false));
    expect(generateEbookImage).not.toHaveBeenCalled();
    expect(generateBlockImage).toHaveBeenCalledTimes(2);
  });

  it("a drawn style's painted twin is stamped arm none with fallback_drawn", async () => {
    await generateSocialPostImage({ ...social(false), learning: { made: stampOn("learned"), lookUsed: true, fallbackDrawn: true } });
    expect(recorded().made).toMatchObject({ arm: "none", made: "m1.image_style.natural_photo.2.n", sources: ["refs:2", "best_of:3", "fallback_drawn"] });
  });
});

describe("an eBook image", () => {
  const ebook = (over: Record<string, unknown> = {}) => ({
    tenantId: "ten_hearth",
    workspaceId: "ws_hearth",
    brief: "A loaf scored in a wheat pattern",
    aspect: "1:1" as const,
    style: "natural_photo",
    brandContext: "Brand context",
    region: "us" as const,
    assetId: "img-ebook-1",
    usage: NO_USAGE,
    learning: { made: { ...stampOn("holdback"), kind: "ebook_image" as const }, lookUsed: false, holdback: true },
    ...over,
  });

  it("held back: the brand's own references stay and the liked ones go", async () => {
    await generateEbookSlotImage(ebook());
    expect(vi.mocked(generateEbookImage).mock.calls[0]![0].styleRefImages).toEqual(refs.assets);
    expect(recorded()).toMatchObject({ id: "img-ebook-1", made: { arm: "holdback", kind: "ebook_image" } });
  });

  it("an edit reads no look, so it is arm none whatever the hash said", async () => {
    await generateEbookSlotImage(ebook({ priorImageRef: "prior.png", brief: "make the background navy" }));
    expect(vi.mocked(generateEbookImage).mock.calls[0]![0].styleRefImages).toEqual([]);
    expect(recorded().made).toMatchObject({ arm: "none", made: "m1.image_style.natural_photo.2.n" });
  });
});

describe("an image whose library row can't be written (4.1)", () => {
  it("a post image still goes out, and its stamp counts stamp_lost", async () => {
    vi.mocked(recordImageAsset).mockRejectedValueOnce(new Error("firestore down"));
    const r = await generateSocialPostImage(social(false));
    expect(r.imageAssetRef).toBe("img.png");
    expect(countLostStamp).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_hearth", region: "us" }), r.made);
  });

  it("an eBook image too, under its own kind", async () => {
    vi.mocked(recordImageAsset).mockRejectedValueOnce(new Error("firestore down"));
    const r = await generateSocialPostImage(social(false));
    expect(r.imageAssetRef).toBe("img.png");
    vi.mocked(countLostStamp).mockClear();
    vi.mocked(recordImageAsset).mockRejectedValueOnce(new Error("firestore down"));
    await generateEbookSlotImage({
      tenantId: "ten_hearth",
      workspaceId: "ws_hearth",
      brief: "A loaf scored in a wheat pattern",
      aspect: "1:1" as const,
      style: "natural_photo",
      brandContext: "Brand context",
      region: "us" as const,
      usage: NO_USAGE,
      learning: { made: { ...stampOn("learned"), kind: "ebook_image" as const }, lookUsed: true, holdback: false },
    });
    expect(countLostStamp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "ebook_image" }));
  });

  it("counts nothing lost when the row is written", async () => {
    await generateSocialPostImage(social(false));
    expect(countLostStamp).not.toHaveBeenCalled();
  });
});

describe("an email hero", () => {
  const hero = (learnedImageStyle?: string | null) =>
    generateHeroImage({ campaign: { id: "camp" } as never, brief: "Opening day", tenantId: "ten_hearth", baseUrl: "https://app.example.com", usage: NO_USAGE, learnedImageStyle });

  it("takes the learned look into its brief once versions give it one; with none, the brief is as before", async () => {
    await hero("Warm daylight on flour.");
    expect(vi.mocked(generateText).mock.calls.at(-1)![0]).toContain("Learned brand image style (from images the team liked): Warm daylight on flour.");
    await hero(undefined);
    expect(vi.mocked(generateText).mock.calls.at(-1)![0]).not.toContain("Learned brand image style");
    await hero(null);
    expect(vi.mocked(generateText).mock.calls.at(-1)![0]).not.toContain("Learned brand image style");
  });
});
