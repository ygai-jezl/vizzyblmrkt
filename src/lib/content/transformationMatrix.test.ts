import { describe, it, expect } from "vitest";
import { transformFor, TRANSFORMATIONS } from "./transformationMatrix";

describe("transformationMatrix", () => {
  it("maps known block × channel pairs (the brief's matrix)", () => {
    expect(transformFor("data-point", "x").format).toBe("x-stat");
    expect(transformFor("hook", "newsletter").format).toBe("newsletter-opener");
    expect(transformFor("case-study", "instagram").format).toBe("instagram-carousel");
    expect(transformFor("cta", "instagram").format).toBe("instagram-caption");
  });

  it("falls back to a channel default for unknown pairs", () => {
    const t = transformFor("comparison", "instagram");
    expect(t.channel).toBe("instagram");
    expect(t.format).toBeTruthy();
    expect(t.hint).toBeTruthy();
  });

  it("every matrix entry has a non-empty format + hint", () => {
    for (const t of TRANSFORMATIONS) {
      expect(t.format).toBeTruthy();
      expect(t.hint.length).toBeGreaterThan(0);
    }
  });
});
