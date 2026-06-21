import { describe, it, expect } from "vitest";
import { confidenceHint, twoProportionZ } from "./significance";

describe("twoProportionZ", () => {
  it("is 0 for empty samples", () => {
    expect(twoProportionZ({ conversions: 0, sample: 0 }, { conversions: 1, sample: 10 })).toBe(0);
  });

  it("grows with a larger gap and bigger samples", () => {
    const small = twoProportionZ({ conversions: 6, sample: 10 }, { conversions: 4, sample: 10 });
    const big = twoProportionZ({ conversions: 600, sample: 1000 }, { conversions: 400, sample: 1000 });
    expect(big).toBeGreaterThan(small);
  });
});

describe("confidenceHint", () => {
  it("returns low for a tiny, noisy sample", () => {
    expect(confidenceHint({ conversions: 6, sample: 10 }, { conversions: 4, sample: 10 })).toBe("low");
  });

  it("returns clear for a large, decisive difference", () => {
    expect(
      confidenceHint({ conversions: 600, sample: 1000 }, { conversions: 400, sample: 1000 }),
    ).toBe("clear");
  });

  it("returns emerging in the middle band", () => {
    // ~80–95% confidence: counts that land z between 1.28 and 1.96 (≈1.41).
    const hint = confidenceHint(
      { conversions: 55, sample: 100 },
      { conversions: 45, sample: 100 },
    );
    expect(hint).toBe("emerging");
  });
});
