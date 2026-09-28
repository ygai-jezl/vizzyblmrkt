import { describe, it, expect } from "vitest";
import {
  averageInk,
  brandKitWithLogo,
  emailStyleHints,
  fitLogoSize,
  logoHardToSee,
  paletteChips,
  secondColourDefault,
  suggestionForReview,
  HEAVY_LOGO_BYTES,
  type EmailStyleLogoChoice,
  type PendingEmailStyleSuggestion,
} from "./emailStyleForm";
import { contrastRatio } from "@/lib/email/emailStyle";

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

describe("emailStyleHints with the header options", () => {
  const base = { logoBytes: 10_000, logoInk: "#ffffff", headerColor: "#0b1f3a", accentColor: "#0b1f3a" };

  it("solid with Auto text adds nothing, text or not", () => {
    expect(emailStyleHints({ ...base, headerGradientColor: null, headerText: "auto", showsText: true })).toEqual([]);
    // Auto on a solid header is never below 4.58:1, even on a mid grey (only the light-header note).
    expect(emailStyleHints({ ...base, logoInk: null, headerColor: "#777777", headerText: "auto", showsText: true })).toEqual([
      expect.stringMatching(/dark mode/),
    ]);
  });

  it("warns when a forced text colour is below 3:1, but only when the band shows text", () => {
    const black = { ...base, headerColor: "#5b21b6", headerText: "black" as const };
    expect(emailStyleHints({ ...black, showsText: true })).toEqual([
      "Black text is hard to read on this header (2.3:1) — pick Auto, or a lighter header",
    ]);
    expect(emailStyleHints({ ...black, showsText: false })).toEqual([]);
    expect(emailStyleHints(black)).toEqual([]);

    expect(emailStyleHints({ ...base, logoInk: null, headerColor: "#ffd400", headerText: "white", showsText: true })).toEqual([
      "White text is hard to read on this header (1.4:1) — pick Auto, or a darker header",
      expect.stringMatching(/dark mode/),
    ]);
  });

  it("forced black on the purple-to-indigo gradient reads well enough (3.3:1)", () => {
    expect(
      emailStyleHints({
        ...base,
        headerColor: "#7c3aed",
        headerGradientColor: "#4f46e5",
        headerText: "black",
        showsText: true,
      }),
    ).toEqual([]);
  });

  it("Auto on a light-to-dark gradient warns about part of it", () => {
    expect(
      emailStyleHints({ ...base, logoInk: null, headerColor: "#ffd400", headerGradientColor: "#111111", showsText: true }),
    ).toEqual([
      "The header text is hard to read on part of the gradient (1.4:1) — pick two colours closer in lightness",
      expect.stringMatching(/dark mode/),
    ]);
  });

  it("a forced colour on a gradient Auto can't fix gets the gradient advice, not 'pick Auto'", () => {
    // Auto picks white here too (1.4:1), so switching to it wouldn't help.
    const gradient = { ...base, logoInk: null, headerColor: "#ffd400", headerGradientColor: "#111111", showsText: true };
    expect(emailStyleHints({ ...gradient, headerText: "white" })).toEqual([
      "The header text is hard to read on part of the gradient (1.4:1) — pick two colours closer in lightness",
      expect.stringMatching(/dark mode/),
    ]);
    // Forced black is worse still (1.1:1), and Auto still can't reach 3:1.
    expect(emailStyleHints({ ...gradient, headerText: "black" })).toEqual([
      "The header text is hard to read on part of the gradient (1.1:1) — pick two colours closer in lightness",
      expect.stringMatching(/dark mode/),
    ]);
    // Where Auto would read well (black, on two light colours), the advice is still to pick it.
    expect(emailStyleHints({ ...gradient, headerGradientColor: "#ffe066", headerText: "white" })).toEqual([
      "White text is hard to read on this header (1.3:1) — pick Auto, or a darker header",
      expect.stringMatching(/dark mode/),
    ]);
  });

  it("the logo warning fires on the gradient's worse colour", () => {
    // A white logo: fine on navy, hard to see on the light end.
    expect(emailStyleHints({ ...base, headerGradientColor: "#eeeeee" })).toEqual([
      expect.stringMatching(/pick a darker header/),
      expect.stringMatching(/dark mode/),
    ]);
    // A dark logo: fine on light grey (solid), hard to see on the navy end.
    const dark = { ...base, logoInk: "#111111", headerColor: "#eeeeee" };
    expect(emailStyleHints(dark)).toEqual([expect.stringMatching(/dark mode/)]);
    expect(emailStyleHints({ ...dark, headerGradientColor: "#0b1f3a" })).toEqual([
      expect.stringMatching(/pick a lighter header/),
      expect.stringMatching(/dark mode/),
    ]);
  });

  it("colour 2 equal to the header colour is a solid header", () => {
    expect(emailStyleHints({ ...base, headerGradientColor: "#0b1f3a", showsText: true })).toEqual([]);
  });
});

describe("secondColourDefault", () => {
  const chips = [
    { hex: "#7c3aed", name: "Purple" },
    { hex: "#4f46e5", name: "Indigo" },
  ];

  it("starts from the first brand colour that isn't the header colour", () => {
    expect(secondColourDefault(chips, "#7c3aed")).toBe("#4f46e5");
    expect(secondColourDefault(chips, "#7C3AED")).toBe("#4f46e5");
    expect(secondColourDefault(chips, "#0b1f3a")).toBe("#7c3aed");
  });

  it("with no other brand colour, the header 30% darker (lighter for a dark header)", () => {
    expect(secondColourDefault([], "#7c3aed")).toBe("#5729a6");
    expect(secondColourDefault([{ hex: "#7c3aed", name: "Purple" }], "#7c3aed")).toBe("#5729a6");
    expect(secondColourDefault([], "#000000")).toBe("#4d4d4d");
    // The page's own default header: darker would be #0c0c0c (1.04:1), which doesn't show.
    expect(secondColourDefault([], "#111111")).toBe("#585858");
    expect(secondColourDefault([], "#0b1f3a")).toBe("#546275");
  });

  it("with no other brand colour, the fade always shows (at least 1.5:1)", () => {
    for (const header of ["#111111", "#1a1a1a", "#0b1f3a", "#333333", "#0000ff", "#7c3aed", "#ffd400", "#ffffff", "#777777"]) {
      expect(contrastRatio(secondColourDefault([], header), header)).toBeGreaterThanOrEqual(1.5);
    }
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

  it("loads the suggestion as asked, with its notes (solid, Auto text when it has no header options)", () => {
    expect(suggestionForReview(suggestion, [logo()])).toEqual({
      logoId: "logo_1",
      companyName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
      headerGradientColor: null,
      headerText: "auto",
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

  it("carries the header options: the gradient's colour 2 and a forced text colour", () => {
    const gradient = { ...suggestion, headerColor: "#7c3aed", headerGradientColor: "#4f46e5", headerText: "white" as const };
    expect(suggestionForReview(gradient, [logo()])).toMatchObject({
      headerColor: "#7c3aed",
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });
    // With no logo list too.
    expect(suggestionForReview(gradient, [], { savedLogoId: "logo_1" })).toMatchObject({
      headerGradientColor: "#4f46e5",
      headerText: "white",
    });
    expect(suggestionForReview({ ...suggestion, headerText: "black" }, [logo()])).toMatchObject({
      headerGradientColor: null,
      headerText: "black",
    });
  });

  it("never swaps the colours asked for, even for a hard-to-see logo", () => {
    const dark = { ...suggestion, headerColor: "#111111" };
    expect(suggestionForReview(dark, [logo()])).toMatchObject({ headerColor: "#111111", accentColor: "#ff6b35" });
  });
});
