import { describe, it, expect } from "vitest";
import {
  expandSpintax,
  countVariants,
  validateSpintax,
  hasSpintax,
  previewVariants,
  SPINTAX_MAX_SOURCE_CHARS,
  SPINTAX_MAX_VARIANTS,
} from "./spintax";

/** A deterministic sequence rng for asserting which option is picked. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("expandSpintax", () => {
  it("returns plain text unchanged", () => {
    expect(expandSpintax("no groups here")).toBe("no groups here");
  });

  it("picks one option per group (deterministic rng)", () => {
    // rng 0 → first option, ~0.99 → last option.
    expect(expandSpintax("{Hi|Hello|Hey} there", seqRng([0]))).toBe("Hi there");
    expect(expandSpintax("{Hi|Hello|Hey} there", seqRng([0.99]))).toBe("Hey there");
  });

  it("expands nested groups", () => {
    const out = expandSpintax("{a{1|2}|b}", seqRng([0, 0.99])); // outer→a, inner→2
    expect(out).toBe("a2");
  });

  it("always produces one of the valid variants", () => {
    const variants = new Set<string>();
    for (let i = 0; i < 50; i++) variants.add(expandSpintax("{Hi|Hello|Hey} {world|there}"));
    for (const v of variants) {
      expect(["Hi", "Hello", "Hey"]).toContain(v.split(" ")[0]);
      expect(["world", "there"]).toContain(v.split(" ")[1]);
    }
  });

  it("treats escaped braces/pipes as literals", () => {
    expect(expandSpintax("a \\{ b \\| c \\}")).toBe("a { b | c }");
  });

  it("falls back to the source verbatim on invalid spintax (never throws)", () => {
    expect(expandSpintax("unbalanced {a|b")).toBe("unbalanced {a|b");
  });
});

describe("countVariants", () => {
  it("counts the product across groups and sum within a group", () => {
    expect(countVariants("plain")).toBe(1);
    expect(countVariants("{a|b|c}")).toBe(3);
    expect(countVariants("{a|b} {c|d|e}")).toBe(6);
    expect(countVariants("{a{1|2}|b}")).toBe(3); // (2) + (1)
  });

  it("saturates at the cap instead of overflowing", () => {
    // 20 groups of 3 options each = 3^20 (~3.5B) → saturates.
    const src = "{a|b|c}".repeat(20);
    expect(countVariants(src)).toBe(SPINTAX_MAX_VARIANTS);
  });
});

describe("validateSpintax / hasSpintax", () => {
  it("accepts balanced templates and plain text", () => {
    expect(validateSpintax("{a|b} plain")).toEqual({ ok: true });
    expect(validateSpintax("just text")).toEqual({ ok: true });
  });

  it("rejects unbalanced braces", () => {
    expect(validateSpintax("{a|b")).toMatchObject({ ok: false, error: "unbalanced_braces" });
  });

  it("rejects an over-long source (DoS guard)", () => {
    const big = "x".repeat(SPINTAX_MAX_SOURCE_CHARS + 1);
    expect(validateSpintax(big)).toMatchObject({ ok: false, error: "too_long" });
  });

  it("rejects excessive nesting depth (DoS guard)", () => {
    const deep = "{".repeat(25) + "x" + "}".repeat(25);
    expect(validateSpintax(deep)).toMatchObject({ ok: false, error: "too_deeply_nested" });
  });

  it("hasSpintax distinguishes templates from plain text", () => {
    expect(hasSpintax("{a|b}")).toBe(true);
    expect(hasSpintax("plain text")).toBe(false);
    expect(hasSpintax("bad {a|b")).toBe(false); // invalid → treated as no-spintax
  });
});

describe("previewVariants", () => {
  it("returns deterministic samples for a fixed seed, capped in count", () => {
    const a = previewVariants("{a|b|c} {1|2}", 5, 42);
    const b = previewVariants("{a|b|c} {1|2}", 5, 42);
    expect(a).toEqual(b); // reproducible
    expect(a).toHaveLength(5);
    expect(previewVariants("{a|b}", 1000).length).toBeLessThanOrEqual(20); // capped
  });

  it("returns at least one preview for a bad count (NaN)", () => {
    expect(previewVariants("{a|b}", Number.NaN).length).toBeGreaterThanOrEqual(1);
  });
});

describe("parser edge cases", () => {
  it("treats stray top-level } and | as literals (only groups delimit)", () => {
    expect(validateSpintax("a}b|c")).toEqual({ ok: true });
    expect(expandSpintax("hello } world")).toBe("hello } world");
    expect(expandSpintax("{a|b}}", seqRng([0]))).toBe("a}"); // group then literal }
  });

  it("handles a trailing backslash without crashing", () => {
    expect(expandSpintax("a\\")).toBe("a\\");
  });

  it("clamps rng()===1.0 to the last option (no out-of-range)", () => {
    expect(expandSpintax("{a|b}", () => 1)).toBe("b");
  });

  it("treats an empty alternative / empty group as a valid empty variant", () => {
    expect(countVariants("{a||b}")).toBe(3);
    expect(expandSpintax("x{a||b}y", seqRng([0.5]))).toBe("xy"); // middle (empty) option
    expect(countVariants("{}")).toBe(1);
    expect(expandSpintax("x{}y")).toBe("xy");
  });

  it("saturates count for wide groups and stays a finite integer", () => {
    const c = countVariants("{a|b|c|d|e|f|g|h|i|j}".repeat(19));
    expect(c).toBe(SPINTAX_MAX_VARIANTS);
    expect(Number.isInteger(c)).toBe(true);
  });
});
