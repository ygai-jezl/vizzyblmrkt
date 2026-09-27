import { describe, it, expect } from "vitest";
import {
  averageInk,
  brandKitWithLogo,
  emailStyleHints,
  fitLogoSize,
  logoHardToSee,
  paletteChips,
  suggestionForReview,
  HEAVY_LOGO_BYTES,
  type EmailStyleLogoChoice,
  type PendingEmailStyleSuggestion,
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

describe("suggestionForReview", () => {
  const logo = (over: Partial<EmailStyleLogoChoice> = {}): EmailStyleLogoChoice => ({
    id: "logo_1",
    filename: "0f8fad5b-d9cb-469f-a165-70867728950e.png",
    mimeType: "image/png",
    isPrimary: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    title: "Logo",
    byteSize: 1000,
    ...over,
  });
  const suggestion: PendingEmailStyleSuggestion = {
    logoId: "logo_1",
    companyName: "Example Co",
    headerColor: "#0b1f3a",
    accentColor: "#ff6b35",
    source: "chat",
    brief: "Make the header navy",
    notes: ["A note from Vizzy"],
    suggestedAt: "2026-09-27T10:00:00.000Z",
  };

  it("loads the suggestion as asked, with its notes", () => {
    expect(suggestionForReview(suggestion, [logo()])).toEqual({
      logoId: "logo_1",
      companyName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
      notes: ["A note from Vizzy"],
    });
    expect(suggestionForReview({ ...suggestion, logoId: null }, [logo()])).toMatchObject({ logoId: null, notes: ["A note from Vizzy"] });
  });

  it("a deleted logo, or one email can't show, falls back to no logo with a note", () => {
    const gone = suggestionForReview(suggestion, []);
    expect(gone.logoId).toBeNull();
    expect(gone.notes).toEqual(["A note from Vizzy", expect.stringMatching(/has been deleted/)]);

    const webp = suggestionForReview(suggestion, [
      logo({ mimeType: "image/webp", filename: "0f8fad5b-d9cb-469f-a165-70867728950e.webp" }),
    ]);
    expect(webp.logoId).toBeNull();
    expect(webp.notes[1]).toMatch(/can't be shown in email/);
  });

  it("with no logo list, only the saved logo is known; any other keeps the saved one, never 'deleted'", () => {
    const saved = { savedLogoId: "logo_1" };
    expect(suggestionForReview(suggestion, [], saved)).toMatchObject({ logoId: "logo_1", notes: ["A note from Vizzy"] });
    expect(suggestionForReview({ ...suggestion, logoId: null }, [], saved)).toMatchObject({ logoId: null });

    const other = suggestionForReview({ ...suggestion, logoId: "logo_2" }, [], saved);
    expect(other.logoId).toBe("logo_1");
    expect(other.notes).toEqual(["A note from Vizzy", expect.stringMatching(/couldn't be loaded/)]);
    expect(suggestionForReview(suggestion, [], { savedLogoId: null }).logoId).toBeNull();

    // Logos switched off says so, rather than "try again later".
    const off = suggestionForReview({ ...suggestion, logoId: "logo_2" }, [], { ...saved, logosOff: true });
    expect(off.logoId).toBe("logo_1");
    expect(off.notes).toEqual(["A note from Vizzy", expect.stringMatching(/aren't switched on/)]);
    expect(off.notes.join(" ")).not.toMatch(/couldn't be loaded|try/);
  });

  it("never swaps the colours asked for, even for a hard-to-see logo", () => {
    const dark = { ...suggestion, headerColor: "#111111" };
    expect(suggestionForReview(dark, [logo()])).toMatchObject({ headerColor: "#111111", accentColor: "#ff6b35" });
  });
});
