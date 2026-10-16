import { describe, expect, it } from "vitest";
import { mergeExtractedFonts, mergeExtractedPalette } from "./brandKitMerge";

describe("a guidelines PDF adds to the brand kit", () => {
  it("keeps the colours already there, with their names, and adds only new ones", () => {
    const mine = [
      { hex: "#1D4ED8", name: "Primary" },
      { hex: "#F59E0B", name: "Accent" },
    ];
    const pdf = [{ hex: "#1d4ed8", name: "Brand blue" }, { hex: "#111827", name: "Ink" }];
    expect(mergeExtractedPalette(mine, pdf)).toEqual([...mine, { hex: "#111827", name: "Ink" }]);
  });

  it("uses the PDF's colours when there were none, and caps the palette", () => {
    expect(mergeExtractedPalette(null, [{ hex: "#000000" }])).toEqual([{ hex: "#000000" }]);
    expect(mergeExtractedPalette([], null)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({ hex: `#0000${String(i).padStart(2, "0")}` }));
    expect(mergeExtractedPalette([], many)).toHaveLength(24);
  });

  it("does the same for fonts, ignoring case", () => {
    expect(mergeExtractedFonts(["Inter"], ["inter", "Lora"])).toEqual(["Inter", "Lora"]);
    expect(mergeExtractedFonts(null, null)).toBeNull();
  });
});
