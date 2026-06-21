import { describe, it, expect } from "vitest";
import { allocateVariant, resolveArmContent, CONTROL } from "./allocation";
import type { AbTest, JourneyNode } from "@/lib/types/journey";

function abTest(over: Partial<AbTest> = {}): AbTest {
  return {
    enabled: true,
    status: "running",
    splitPercent: 50,
    variants: [
      { variantId: "var_a", subject: "A", body: "a" },
      { variantId: "var_b", subject: "B", body: "b" },
    ],
    ...over,
  };
}

describe("allocateVariant", () => {
  it("returns control when there is no test, it's disabled, or promoted", () => {
    expect(allocateVariant("n", "s", undefined).variantId).toBe(CONTROL);
    expect(allocateVariant("n", "s", abTest({ enabled: false })).variantId).toBe(CONTROL);
    expect(allocateVariant("n", "s", abTest({ status: "promoted" })).variantId).toBe(CONTROL);
  });

  it("is deterministic for the same (node, recipient)", () => {
    const t = abTest();
    const first = allocateVariant("email1", "s123", t).variantId;
    for (let i = 0; i < 20; i++) {
      expect(allocateVariant("email1", "s123", t).variantId).toBe(first);
    }
  });

  it("honours the hold-out: ~splitPercent enter the test, rest get control", () => {
    const t = abTest({ splitPercent: 30 });
    let inTest = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const v = allocateVariant("email1", `s${i}`, t).variantId;
      if (v !== CONTROL) inTest += 1;
    }
    const frac = inTest / N;
    expect(frac).toBeGreaterThan(0.26);
    expect(frac).toBeLessThan(0.34);
  });

  it("in-test recipients only ever get a challenger (never control)", () => {
    const t = abTest({ splitPercent: 100 }); // everyone enters the test
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(allocateVariant("n", `s${i}`, t).variantId);
    expect(seen.has(CONTROL)).toBe(false);
    expect(seen).toContain("var_a");
    expect(seen).toContain("var_b");
  });
});

describe("resolveArmContent", () => {
  const node: JourneyNode = {
    id: "email1",
    type: "email",
    position: { x: 0, y: 0 },
    data: {
      subject: "Base subject",
      body: "Base body",
      heroImageUrl: "base.png",
      abTest: abTest(),
    },
  };

  it("returns the base copy for control", () => {
    expect(resolveArmContent(node, CONTROL)).toEqual({
      subject: "Base subject",
      body: "Base body",
      heroImageUrl: "base.png",
    });
  });

  it("returns a variant's copy", () => {
    expect(resolveArmContent(node, "var_b")).toEqual({
      subject: "B",
      body: "b",
      heroImageUrl: null,
    });
  });

  it("falls back to control for an unknown/deleted variant id", () => {
    expect(resolveArmContent(node, "var_gone").subject).toBe("Base subject");
  });
});
