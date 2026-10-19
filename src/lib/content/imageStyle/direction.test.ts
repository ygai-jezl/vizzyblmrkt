import { describe, expect, it } from "vitest";
import { briefWithDirection, modelDirectionFor } from "./direction";
import { resolveImageStyle } from "./resolve";

describe("modelDirectionFor", () => {
  it("an old preset has no direction; a model style has its own; a template uses its model twin", () => {
    expect(modelDirectionFor({ engine: "legacy", presetId: "retro", source: "legacy" })).toEqual({ styleId: "retro", direction: null });
    expect(modelDirectionFor(resolveImageStyle({ enabled: true, surface: "social", override: "soft_3d" }))).toMatchObject({
      styleId: "soft_3d",
      direction: { label: "Soft 3D" },
    });
    expect(modelDirectionFor(resolveImageStyle({ enabled: true, surface: "social", override: "product_noir" }))).toMatchObject({
      styleId: "product_still_life",
      direction: { label: "Product still life" },
    });
  });

  it("writes the style into a brief only when there is one", () => {
    expect(briefWithDirection("A desk", null)).toBe("A desk");
    expect(briefWithDirection("A desk", { label: "Soft 3D", keywords: "glossy" })).toBe("A desk\n\nVisual style (Soft 3D): glossy.");
  });
});
