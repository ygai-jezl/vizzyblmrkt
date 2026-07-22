import { describe, it, expect } from "vitest";
import { normalizeHex, harvestCssColors, mergeColors, clampColors, HEX6 } from "./colorPalette";

describe("normalizeHex", () => {
  it("passes through and lowercases a 6-digit hex", () => {
    expect(normalizeHex("#AABBCC")).toBe("#aabbcc");
    expect(normalizeHex("  #aAbBcC ")).toBe("#aabbcc");
  });

  it("expands 3-digit shorthand", () => {
    expect(normalizeHex("#0af")).toBe("#00aaff");
    expect(normalizeHex("0af")).toBe("#00aaff"); // no leading #
  });

  it("drops alpha from #rgba and #rrggbbaa", () => {
    expect(normalizeHex("#0af8")).toBe("#00aaff");
    expect(normalizeHex("#aabbcc80")).toBe("#aabbcc");
  });

  it("converts rgb()/rgba() incl. percentages and space syntax", () => {
    expect(normalizeHex("rgb(0, 170, 255)")).toBe("#00aaff");
    expect(normalizeHex("rgba(0,170,255,0.5)")).toBe("#00aaff");
    expect(normalizeHex("rgb(0 170 255 / 50%)")).toBe("#00aaff");
    expect(normalizeHex("rgb(100%, 0%, 0%)")).toBe("#ff0000");
  });

  it("rejects non-colours and malformed hex lengths", () => {
    expect(normalizeHex("#12345")).toBeNull(); // 5 digits
    expect(normalizeHex("#1234567")).toBeNull(); // 7 digits
    expect(normalizeHex("rgb(300,0,0)")).toBeNull(); // out of range
    expect(normalizeHex("blue")).toBeNull(); // named colours unsupported
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex(null)).toBeNull();
  });

  it("only ever emits HEX6-valid output", () => {
    for (const v of ["#0af", "rgb(1,2,3)", "#AABBCCDD", "#fff8"]) {
      const n = normalizeHex(v)!;
      expect(HEX6.test(n)).toBe(true);
    }
  });
});

describe("harvestCssColors", () => {
  it("pulls hex + rgb from inline styles and <style> blocks, deduped + normalized", () => {
    const html = `
      <style>.a{color:#FF0000;background:rgb(0,0,255)}</style>
      <div style="color:#f00;border:1px solid #00FF00">hi</div>
      <span style="background:#ff0000">dup</span>`;
    const got = harvestCssColors(html);
    expect(got).toContain("#ff0000");
    expect(got).toContain("#0000ff");
    expect(got).toContain("#00ff00");
    // #f00 and #FF0000 both normalize to #ff0000 — deduped to one entry.
    expect(got.filter((h) => h === "#ff0000")).toHaveLength(1);
  });

  it("respects the cap", () => {
    const many = Array.from({ length: 50 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`).join(" ");
    expect(harvestCssColors(many, 10)).toHaveLength(10);
  });

  it("returns empty for colourless html", () => {
    expect(harvestCssColors("<p>no colours here</p>")).toEqual([]);
  });
});

describe("mergeColors", () => {
  it("dedupes case-insensitively and preserves the first name/role", () => {
    const existing = [{ hex: "#ff0000", name: "Red" }];
    const { merged, skipped } = mergeColors(existing, [
      { hex: "#FF0000", name: "Crimson" }, // dup → absorbed, not skipped
      { hex: "#00ff00", name: "Green", role: "accent" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ hex: "#ff0000", name: "Red" });
    expect(merged[1]).toEqual({ hex: "#00ff00", name: "Green", role: "accent" });
    expect(skipped).toBe(0);
  });

  it("caps at max and reports the overflow as skipped", () => {
    const existing = Array.from({ length: 3 }, (_, i) => ({ hex: `#00000${i}` }));
    const additions = [{ hex: "#111111" }, { hex: "#222222" }];
    const { merged, skipped } = mergeColors(existing, additions, 4);
    expect(merged).toHaveLength(4); // only one of the two fits
    expect(skipped).toBe(1);
  });

  it("skips colours whose hex will not normalize", () => {
    const { merged, skipped } = mergeColors([], [{ hex: "not-a-colour" }, { hex: "#abc" }]);
    expect(merged).toEqual([{ hex: "#aabbcc" }]);
    expect(skipped).toBe(1);
  });
});

describe("clampColors", () => {
  it("normalizes hex, clamps name/role, drops invalid + duplicates", () => {
    const out = clampColors([
      { hex: "#F00", name: "Primary", role: "primary" },
      { hex: "rgb(0,0,255)" },
      { hex: "garbage" },
      { hex: "#ff0000", name: "dup" }, // duplicate of the first
      { notHex: true },
    ]);
    expect(out).toEqual([
      { hex: "#ff0000", name: "Primary", role: "primary" },
      { hex: "#0000ff" },
    ]);
  });

  it("coerces estimated from the model, and forces it when requested", () => {
    expect(clampColors([{ hex: "#abcdef", estimated: true }])[0]).toEqual({
      hex: "#abcdef",
      estimated: true,
    });
    expect(clampColors([{ hex: "#abcdef" }], { forceEstimated: true })[0]!.estimated).toBe(true);
  });

  it("returns [] for non-arrays and caps at 48", () => {
    expect(clampColors(null)).toEqual([]);
    expect(clampColors("nope")).toEqual([]);
    const big = Array.from({ length: 60 }, (_, i) => ({ hex: `#0000${i.toString(16).padStart(2, "0")}` }));
    expect(clampColors(big)).toHaveLength(48);
  });
});
