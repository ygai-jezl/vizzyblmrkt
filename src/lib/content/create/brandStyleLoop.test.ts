import { describe, it, expect, afterEach } from "vitest";
import {
  isBrandStyleLoopEnabled,
  isBrandStyleRefsEnabled,
  isBestOfNEnabled,
  bestOfNCount,
} from "./brandStyleLoop";

const KEYS = [
  "BRAND_STYLE_LOOP_ENABLED",
  "BRAND_STYLE_REFS_ENABLED",
  "BRAND_BEST_OF_N",
  "BRAND_BEST_OF_N_COUNT",
] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("brand-style loop flags", () => {
  it("all gates default OFF when unset", () => {
    expect(isBrandStyleLoopEnabled()).toBe(false);
    expect(isBrandStyleRefsEnabled()).toBe(false);
    expect(isBestOfNEnabled()).toBe(false);
  });

  it("gates are on only for the exact string \"true\"", () => {
    process.env.BRAND_STYLE_LOOP_ENABLED = "true";
    process.env.BRAND_STYLE_REFS_ENABLED = "1"; // not "true"
    expect(isBrandStyleLoopEnabled()).toBe(true);
    expect(isBrandStyleRefsEnabled()).toBe(false);
  });

  it("bestOfNCount defaults to 2 and clamps to 2–4", () => {
    expect(bestOfNCount()).toBe(2); // unset
    process.env.BRAND_BEST_OF_N_COUNT = "1";
    expect(bestOfNCount()).toBe(2); // floor
    process.env.BRAND_BEST_OF_N_COUNT = "9";
    expect(bestOfNCount()).toBe(4); // ceil
    process.env.BRAND_BEST_OF_N_COUNT = "3";
    expect(bestOfNCount()).toBe(3);
    process.env.BRAND_BEST_OF_N_COUNT = "abc";
    expect(bestOfNCount()).toBe(2); // non-numeric
  });
});
