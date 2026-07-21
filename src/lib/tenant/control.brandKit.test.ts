import { describe, it, expect } from "vitest";
import { withPreservedLearnedStyle } from "./control";
import type { BrandKit } from "@/lib/types/tenant";

describe("withPreservedLearnedStyle", () => {
  it("carries the learned style forward when a PDF re-extract omits it", () => {
    const fresh: BrandKit = { summary: "New kit", palette: [{ hex: "#123456" }] };
    const existing: BrandKit = {
      summary: "Old kit",
      learnedImageStyle: "soft daylight, muted palette",
      learnedImageStyleUpdatedAt: "2026-07-20T00:00:00.000Z",
      learnedImageStyleSampleCount: 12,
    };
    const merged = withPreservedLearnedStyle(fresh, existing);
    // New PDF fields win; learned-style fields are preserved.
    expect(merged.summary).toBe("New kit");
    expect(merged.palette).toEqual([{ hex: "#123456" }]);
    expect(merged.learnedImageStyle).toBe("soft daylight, muted palette");
    expect(merged.learnedImageStyleSampleCount).toBe(12);
  });

  it("nulls the learned fields when the tenant had none", () => {
    const merged = withPreservedLearnedStyle({ summary: "x" }, null);
    expect(merged.learnedImageStyle).toBeNull();
    expect(merged.learnedImageStyleUpdatedAt).toBeNull();
    expect(merged.learnedImageStyleSampleCount).toBeNull();
  });

  it("never lets an incoming payload's learned fields override the existing ones", () => {
    // Even if a stale client sends its own learnedImageStyle, the server value wins.
    const stale: BrandKit = { summary: "x", learnedImageStyle: "STALE" };
    const existing: BrandKit = { learnedImageStyle: "CURRENT" };
    expect(withPreservedLearnedStyle(stale, existing).learnedImageStyle).toBe("CURRENT");
  });
});
