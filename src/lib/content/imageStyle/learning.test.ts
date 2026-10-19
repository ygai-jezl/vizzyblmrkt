import { describe, expect, it } from "vitest";
import { learnedDirectiveFor, learnsFromThumbs } from "./learning";

describe("learnedDirectiveFor", () => {
  it("uses the brand's one learned look until anything is learned per style", () => {
    expect(learnedDirectiveFor(undefined, "soft_3d")).toBeUndefined();
    expect(learnedDirectiveFor({ defaultStyleId: null }, "soft_3d")).toBeUndefined();
    expect(learnedDirectiveFor({ defaultStyleId: null, learned: {} }, "soft_3d")).toBeUndefined();
    expect(learnedDirectiveFor({ defaultStyleId: null, learned: { soft_3d: { directive: "x", sampleCount: 1, updatedAt: "t" } } }, null)).toBeUndefined();
  });

  it("then gives each style only what was learned for it", () => {
    const style = {
      defaultStyleId: null,
      learned: {
        soft_3d: { directive: "Pastel ground.", sampleCount: 3, updatedAt: "t" },
        natural_photo: { directive: null, sampleCount: 0, updatedAt: "t" },
      },
    };
    expect(learnedDirectiveFor(style, "soft_3d")).toBe("Pastel ground.");
    expect(learnedDirectiveFor(style, "natural_photo")).toBeNull();
    expect(learnedDirectiveFor(style, "illustration")).toBeNull();
  });

  it("only image-model styles learn from thumbs", () => {
    expect(learnsFromThumbs("soft_3d")).toBe(true);
    expect(learnsFromThumbs("headline_card")).toBe(false);
    expect(learnsFromThumbs(null)).toBe(false);
  });
});
