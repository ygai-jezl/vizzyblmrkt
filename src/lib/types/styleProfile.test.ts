import { describe, it, expect } from "vitest";
import { StyleProfileSchema } from "./styleProfile";

describe("StyleProfileSchema", () => {
  it("defaults every field so a sparse/empty extraction still parses", () => {
    const p = StyleProfileSchema.parse({});
    expect(p.palette).toEqual([]);
    expect(p.lighting).toBe("");
    expect(p.medium).toBe("");
  });

  it("accepts a full profile", () => {
    const p = StyleProfileSchema.parse({
      palette: ["#112233", "#ffffff"],
      lighting: "soft daylight",
      mood: "calm",
      medium: "photograph",
    });
    expect(p.palette).toHaveLength(2);
    expect(p.medium).toBe("photograph");
  });

  it("caps the palette at 8 entries", () => {
    const many = Array.from({ length: 20 }, () => "#000000");
    expect(() => StyleProfileSchema.parse({ palette: many })).toThrow();
  });
});
