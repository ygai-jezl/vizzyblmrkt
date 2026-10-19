import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kit = vi.hoisted(() => ({
  getImageAsset: vi.fn(),
  updateImageAsset: vi.fn(),
  listBrandExemplars: vi.fn(),
  listBrandNegatives: vi.fn(),
}));
vi.mock("@/lib/admin/brandKit", () => kit);
const control = vi.hoisted(() => ({ setTenantLearnedImageStyle: vi.fn(), setTenantStyleLearned: vi.fn() }));
vi.mock("@/lib/tenant/control", () => control);
const gemini = vi.hoisted(() => ({
  generateText: vi.fn(async (_prompt: string) => "Soft pastel grounds, one glossy object."),
  generateTextWithImage: vi.fn(),
  parseFirstJson: vi.fn(),
}));
vi.mock("@/lib/agents/gemini", () => gemini);

const { refreshLearnedStyleBucket } = await import("./styleProfile");
const ctx = { tenantId: "ten_A", region: "us" } as never;
const row = (id: string, style: string, rating: number, medium: string) => ({
  id,
  style,
  brandRating: rating,
  styleProfile: { medium, palette: [], lighting: "", mood: "", composition: "", texture: "", postProcessing: "", subjectTreatment: "" },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("refreshLearnedStyleBucket", () => {
  it("learns from this style's thumbs only (old presets count towards the style they map to)", async () => {
    kit.listBrandExemplars.mockResolvedValue([
      row("a", "soft_3d", 9, "3D clay render"),
      row("b", "natural_photo", 10, "daylight photo"),
      row("c", "vibrant", 7, "glossy toy render"), // the old Vibrant preset maps to Soft 3D
    ]);
    kit.listBrandNegatives.mockResolvedValue([row("d", "soft_3d", 1, "harsh neon render"), row("e", "natural_photo", 1, "grey photo")]);
    await refreshLearnedStyleBucket(ctx, "soft_3d");
    const prompt = gemini.generateText.mock.calls[0]![0];
    expect(prompt).toContain("3D clay render");
    expect(prompt).toContain("glossy toy render");
    expect(prompt).not.toContain("daylight photo");
    expect(prompt).toContain("harsh neon render");
    expect(prompt).not.toContain("grey photo");
    expect(control.setTenantStyleLearned).toHaveBeenCalledWith("ten_A", "soft_3d", {
      directive: "Soft pastel grounds, one glossy object.",
      sampleCount: 2,
    });
    expect(control.setTenantLearnedImageStyle).not.toHaveBeenCalled();
  });

  it("clears the style when its last thumb up is gone, and does nothing with the loop off", async () => {
    kit.listBrandExemplars.mockResolvedValue([row("b", "natural_photo", 10, "daylight photo")]);
    kit.listBrandNegatives.mockResolvedValue([]);
    await refreshLearnedStyleBucket(ctx, "soft_3d");
    expect(control.setTenantStyleLearned).toHaveBeenCalledWith("ten_A", "soft_3d", { directive: null, sampleCount: 0 });

    vi.clearAllMocks();
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "");
    await refreshLearnedStyleBucket(ctx, "soft_3d");
    expect(kit.listBrandExemplars).not.toHaveBeenCalled();
  });
});
