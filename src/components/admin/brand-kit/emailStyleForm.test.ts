import { describe, it, expect } from "vitest";
import {
  averageInk,
  brandKitWithLogo,
  emailStyleHints,
  fitLogoSize,
  logoHardToSee,
  paletteChips,
  HEAVY_LOGO_BYTES,
} from "./emailStyleForm";

const px = (...pixels: Array<[number, number, number, number]>) => pixels.flat();

describe("fitLogoSize", () => {
  it("scales a big logo down to fit 200×48, keeping its shape", () => {
    expect(fitLogoSize(1000, 240)).toEqual({ width: 200, height: 48 });
    expect(fitLogoSize(400, 400)).toEqual({ width: 48, height: 48 });
    expect(fitLogoSize(2000, 100)).toEqual({ width: 200, height: 10 });
  });

  it("never scales a small logo up", () => {
    expect(fitLogoSize(120, 30)).toEqual({ width: 120, height: 30 });
  });

  it("an unloaded image has no size", () => {
    expect(fitLogoSize(0, 0)).toBeNull();
    expect(fitLogoSize(Number.NaN, 10)).toBeNull();
  });
});

describe("averageInk", () => {
  it("averages opaque pixels only", () => {
    expect(averageInk(px([0, 0, 0, 255], [255, 255, 255, 0], [20, 40, 60, 255]))).toBe("#0a141e");
  });

  it("a fully transparent image has no ink", () => {
    expect(averageInk(px([0, 0, 0, 0], [255, 255, 255, 10]))).toBeNull();
    expect(averageInk([])).toBeNull();
  });
});

describe("logo contrast", () => {
  it("a dark logo on a dark header is hard to see; unknown ink never warns", () => {
    expect(logoHardToSee("#111111", "#0b1f3a")).toBe(true);
    expect(logoHardToSee("#111111", "#ffffff")).toBe(false);
    expect(logoHardToSee(null, "#0b1f3a")).toBe(false);
  });

  it("Use brand kit: a dark logo on a dark brand colour gets a white header and the brand colour on the button", () => {
    const kit = { logoId: "l1", companyName: null, headerColor: "#0b1f3a", accentColor: "#e4572e", notes: [] };
    const out = brandKitWithLogo(kit, "#111111");
    expect(out).toMatchObject({ headerColor: "#ffffff", accentColor: "#0b1f3a" });
    expect(out.notes).toHaveLength(1);
  });

  it("Use brand kit keeps the brand colour when the logo reads on it, or reads no better on white", () => {
    const kit = { logoId: "l1", companyName: null, headerColor: "#0b1f3a", accentColor: "#e4572e", notes: [] };
    expect(brandKitWithLogo(kit, "#ffffff")).toBe(kit);
    expect(brandKitWithLogo(kit, null)).toBe(kit);
    const light = { ...kit, headerColor: "#f4f4f4" };
    expect(brandKitWithLogo(light, "#fafafa")).toBe(light);
  });
});

describe("emailStyleHints", () => {
  const base = { logoBytes: 10_000, logoInk: "#ffffff", headerColor: "#0b1f3a", accentColor: "#0b1f3a" };

  it("a readable dark style has no hints", () => {
    expect(emailStyleHints(base)).toEqual([]);
  });

  it("#FFD400 as the button colour: links stay dark", () => {
    expect(emailStyleHints({ ...base, accentColor: "#FFD400" })).toEqual([expect.stringMatching(/too light for text links/)]);
  });

  it("warns about a heavy logo, a hard-to-see logo and a light header", () => {
    expect(emailStyleHints({ ...base, logoBytes: HEAVY_LOGO_BYTES + 1 })).toEqual([expect.stringMatching(/over 200 KB/)]);
    expect(emailStyleHints({ ...base, logoInk: "#111111" })).toEqual([expect.stringMatching(/pick a lighter header/)]);
    expect(emailStyleHints({ ...base, headerColor: "#eeeeee", logoInk: "#ffffff" })).toEqual([
      expect.stringMatching(/pick a darker header/),
      expect.stringMatching(/dark mode/),
    ]);
  });
});

describe("paletteChips", () => {
  it("normalises and dedupes palette then palettes, and caps the list", () => {
    const kit = {
      palette: [{ hex: "#ABC", name: "Sky" }, { hex: "#aabbcc", name: "Dup" }, { hex: "nope" }],
      palettes: [{ id: "g1", name: "PDF", colors: [{ hex: "#0B1F3A80", name: null }] }],
    };
    expect(paletteChips(kit)).toEqual([
      { hex: "#aabbcc", name: "Sky" },
      { hex: "#0b1f3a", name: "#0b1f3a" },
    ]);
    expect(paletteChips(kit, 1)).toHaveLength(1);
    expect(paletteChips(null)).toEqual([]);
  });
});
