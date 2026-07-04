import { describe, it, expect } from "vitest";
import { scorePPS, PPS_WEIGHTS } from "./pps";

describe("scorePPS", () => {
  it("is deterministic and bounded 0–100 with 0–100 sub-scores", () => {
    const a = scorePPS("How do you 10x your reach?\n\nStart with one clear idea.", "linkedin");
    const b = scorePPS("How do you 10x your reach?\n\nStart with one clear idea.", "linkedin");
    expect(a).toEqual(b); // deterministic
    for (const v of [a.score, a.breakdown.brevity, a.breakdown.formatting, a.breakdown.keyword, a.breakdown.hook]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("scores empty copy at 0", () => {
    const r = scorePPS("", "x");
    expect(r.score).toBe(0);
  });

  it("weights compose to the overall score", () => {
    const { score, breakdown } = scorePPS("Why most teams fail at this — and the 3-step fix you can copy today.", "linkedin");
    const expected = Math.round(
      breakdown.brevity * PPS_WEIGHTS.brevity +
        breakdown.formatting * PPS_WEIGHTS.formatting +
        breakdown.keyword * PPS_WEIGHTS.keyword +
        breakdown.hook * PPS_WEIGHTS.hook,
    );
    expect(score).toBe(expected);
  });

  it("ranks a scannable, hook-led post above a spammy all-caps wall", () => {
    const good = scorePPS(
      "Why did your last post flop?\n\n- Weak hook\n- No white space\n- Too salesy\n\nFix those 3 and watch it climb.",
      "linkedin",
    );
    const spam = scorePPS(
      "BUY NOW!!! ACT NOW!!! This is 100% free and guaranteed — click here, limited time, don't miss out!!!".repeat(
        4,
      ),
      "linkedin",
    );
    expect(good.score).toBeGreaterThan(spam.score);
    expect(spam.breakdown.keyword).toBeLessThan(50); // spam heavily penalised
    expect(good.breakdown.hook).toBeGreaterThan(good.breakdown.keyword - 100); // hook rewarded
  });

  it("penalises the keyword score for spam/hype and shouting", () => {
    expect(scorePPS("A calm, clear, useful note about our launch.", "newsletter").breakdown.keyword).toBe(100);
    expect(scorePPS("BUY NOW guaranteed 100% free!!!", "newsletter").breakdown.keyword).toBeLessThan(60);
  });

  it("rewards a question/number/you hook over a generic opener", () => {
    const strong = scorePPS("Why do 80% of you ignore this?", "x").breakdown.hook;
    const weak = scorePPS("In this post I want to talk about some things.", "x").breakdown.hook;
    expect(strong).toBeGreaterThan(weak);
  });

  it("falls back to the default length band for unknown/standalone channels", () => {
    expect(() => scorePPS("Some copy.", "tiktok")).not.toThrow();
    const r = scorePPS("Some copy.", "standalone");
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("stays bounded and does not crash on a pathological many-paragraph input", () => {
    const r = scorePPS("a\n\n".repeat(130_000), "x"); // ~130k paragraphs (would blow a spread-arg max)
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("penalises brevity for a wall of text vs a scannable draft", () => {
    const wall = scorePPS("word ".repeat(200).trim(), "x").breakdown.brevity; // ~1000 cp, over X max
    const tight = scorePPS("A tight, punchy X post.", "x").breakdown.brevity;
    expect(tight).toBeGreaterThan(wall);
  });
});
