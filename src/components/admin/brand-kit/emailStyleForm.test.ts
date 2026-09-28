import { describe, it, expect } from "vitest";
import {
  averageInk,
  brandFontsToEmail,
  brandKitWithLogo,
  emailFontForFamily,
  emailFontOption,
  emailStyleHints,
  emailStyleSaveInput,
  fitLogoSize,
  headerAfterDelete,
  isBrandFontNote,
  logoForSave,
  logoHardToSee,
  pageFontStack,
  pageWebFontFaces,
  paletteChips,
  presetTheme,
  sameTheme,
  secondColourDefault,
  suggestionForReview,
  themeForForm,
  themeLabel,
  HEAVY_LOGO_BYTES,
  type EmailStyleLogoChoice,
  type PendingEmailStyleSuggestion,
} from "./emailStyleForm";
import { contrastRatio } from "@/lib/email/emailStyle";
import { EmailStyleInputSchema, type TextStyle } from "@/lib/types/tenant";

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

describe("emailStyleHints in Image mode (a header image)", () => {
  // A logo hard to see on this header, and forced black text on navy: both warn in Colour mode.
  const colour = {
    logoBytes: HEAVY_LOGO_BYTES + 1,
    logoInk: "#111111",
    headerColor: "#0b1f3a",
    accentColor: "#0b1f3a",
    headerText: "black" as const,
    showsText: true,
  };
  const banner = { width: 1200, height: 300, byteSize: 100_000 };

  it("drops the logo and header-text hints", () => {
    expect(emailStyleHints(colour)).toHaveLength(3);
    expect(emailStyleHints({ ...colour, headerImage: banner })).toEqual([]);
    // With none picked yet, too.
    expect(emailStyleHints({ ...colour, headerImage: null })).toEqual([]);
  });

  it("keeps the link hint, and adds the banner's own (weight over 300 KB, narrow, tall), first", () => {
    expect(emailStyleHints({ ...colour, accentColor: "#FFD400", headerImage: banner })).toEqual([
      expect.stringMatching(/too light for text links/),
    ]);
    expect(emailStyleHints({ ...colour, headerImage: { ...banner, byteSize: 300 * 1024 + 1 } })).toEqual([
      expect.stringMatching(/over 300 KB, so it may load slowly on phones/),
    ]);
    expect(
      emailStyleHints({ ...colour, accentColor: "#FFD400", headerImage: { width: 500, height: 400, byteSize: null } }),
    ).toEqual([
      expect.stringMatching(/under 600px wide/),
      expect.stringMatching(/tall for a header \(480 px/),
      expect.stringMatching(/too light for text links/),
    ]);
  });

  it("keeps the dark-mode hint for a light header colour, gradient or not, and not for a dark one", () => {
    const light = { ...colour, logoInk: null, headerColor: "#eeeeee", headerGradientColor: "#0b1f3a" };
    expect(emailStyleHints({ ...light, headerImage: banner })).toEqual([expect.stringMatching(/dark mode/)]);
    // A dark header colour with a light Colour 2: the gradient isn't drawn behind a banner.
    const dark = { ...colour, logoInk: null, headerColor: "#0b1f3a", headerGradientColor: "#eeeeee" };
    expect(emailStyleHints(dark)).toEqual(expect.arrayContaining([expect.stringMatching(/dark mode/)]));
    expect(emailStyleHints({ ...dark, headerImage: banner })).toEqual([]);
  });
});

describe("logoForSave", () => {
  const measured = { id: "logo_2", filename: "0f8fad5b-d9cb-469f-a165-70867728950e.png", width: 120, height: 30 };
  const savedLogo = { id: "logo_1", filename: "7c9e6679-7425-40de-944b-e07fc1f90ae7.png", width: 100, height: 40 };
  const saved = { logo: savedLogo };

  it("Colour mode is as ever: the measured logo, else the kept one; checking or failed blocks", () => {
    expect(logoForSave({ imageMode: false, logoState: "ready", measured, kept: null, saved })).toEqual({
      logo: measured,
      blocked: null,
    });
    expect(logoForSave({ imageMode: false, logoState: "none", measured: null, kept: savedLogo, saved })).toEqual({
      logo: savedLogo,
      blocked: null,
    });
    expect(logoForSave({ imageMode: false, logoState: "none", measured: null, kept: null, saved })).toEqual({
      logo: null,
      blocked: null,
    });
    expect(logoForSave({ imageMode: false, logoState: "checking", measured: null, kept: null, saved }).blocked).toBe(
      "checking",
    );
    expect(logoForSave({ imageMode: false, logoState: "failed", measured: null, kept: null, saved }).blocked).toBe(
      "failed",
    );
  });

  it("Image mode: a logo that won't load sends the saved one and doesn't block", () => {
    expect(logoForSave({ imageMode: true, logoState: "failed", measured: null, kept: null, saved })).toEqual({
      logo: savedLogo,
      blocked: null,
    });
    // Never null in place of a saved logo; with none saved there's nothing to keep.
    expect(logoForSave({ imageMode: true, logoState: "failed", measured: null, kept: null, saved }).logo).not.toBeNull();
    expect(logoForSave({ imageMode: true, logoState: "failed", measured: null, kept: null, saved: null })).toEqual({
      logo: null,
      blocked: null,
    });
  });

  it("Image mode: checking holds the Save; ready sends the measured logo; none sends the kept one", () => {
    expect(logoForSave({ imageMode: true, logoState: "checking", measured: null, kept: null, saved }).blocked).toBe(
      "checking",
    );
    expect(logoForSave({ imageMode: true, logoState: "ready", measured, kept: null, saved })).toEqual({
      logo: measured,
      blocked: null,
    });
    expect(logoForSave({ imageMode: true, logoState: "none", measured: null, kept: savedLogo, saved })).toEqual({
      logo: savedLogo,
      blocked: null,
    });
    expect(logoForSave({ imageMode: true, logoState: "none", measured: null, kept: null, saved })).toEqual({
      logo: null,
      blocked: null,
    });
  });
});

describe("headerAfterDelete", () => {
  const draft = { companyName: "Example Co", headerMode: "image" as const, headerImageId: "img_b" };
  const savedA = { headerMode: "image" as const, headerImageId: "img_a" };
  const savedColour = { headerMode: "colour" as const, headerImageId: null };

  it("a form that hadn't picked the deleted banner is unchanged", () => {
    expect(headerAfterDelete(draft, { id: "img_c", cleared: false }, savedA)).toBe(draft);
  });

  it("an unused banner picked but not saved: back to the saved banner, not Colour", () => {
    expect(headerAfterDelete(draft, { id: "img_b", cleared: false }, savedA)).toEqual({
      companyName: "Example Co",
      headerMode: "image",
      headerImageId: "img_a",
    });
  });

  it("the saved style has no banner (or the saved one isn't listed): as the saved style", () => {
    expect(headerAfterDelete(draft, { id: "img_b", cleared: false }, savedColour)).toEqual({
      companyName: "Example Co",
      headerMode: "colour",
      headerImageId: null,
    });
    expect(
      headerAfterDelete(draft, { id: "img_b", cleared: false }, { headerMode: "image", headerImageId: null }),
    ).toEqual({ companyName: "Example Co", headerMode: "image", headerImageId: null });
  });

  it("the banner the saved style used (cleared): Colour", () => {
    const picked = { ...draft, headerImageId: "img_a" };
    expect(headerAfterDelete(picked, { id: "img_a", cleared: true }, savedA)).toEqual({
      companyName: "Example Co",
      headerMode: "colour",
      headerImageId: null,
    });
    // Cleared by the server though the page's saved copy named another: still Colour.
    expect(headerAfterDelete(draft, { id: "img_b", cleared: true }, savedA)).toEqual({
      companyName: "Example Co",
      headerMode: "colour",
      headerImageId: null,
    });
  });

  it("a form on Colour stays on Colour", () => {
    const colour = { ...draft, headerMode: "colour" as const };
    expect(headerAfterDelete(colour, { id: "img_b", cleared: false }, savedA)).toEqual({
      companyName: "Example Co",
      headerMode: "colour",
      headerImageId: "img_a",
    });
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

  describe("with the header options on (a header image list)", () => {
    const images = [{ id: "hdr_spring" }, { id: "hdr_autumn" }];
    const banner = { ...suggestion, headerImageId: "hdr_spring" };

    it("picks the suggested banner, or the colour header when it has none", () => {
      expect(suggestionForReview(banner, [logo()], undefined, { images, savedImageId: null })).toEqual({
        logoId: "logo_1",
        companyName: "Example Co",
        headerColor: "#0b1f3a",
        accentColor: "#ff6b35",
        headerGradientColor: null,
        headerText: "auto",
        headerImageId: "hdr_spring",
        notes: ["A note from Vizzy"],
      });
      expect(suggestionForReview(suggestion, [logo()], undefined, { images, savedImageId: "hdr_autumn" })).toMatchObject({
        headerImageId: null,
        notes: ["A note from Vizzy"],
      });
    });

    it("a deleted banner falls back to the colour header with a note", () => {
      const gone = suggestionForReview({ ...banner, headerImageId: "hdr_deleted" }, [logo()], undefined, {
        images,
        savedImageId: "hdr_autumn",
      });
      expect(gone.headerImageId).toBeNull();
      expect(gone.notes).toEqual(["A note from Vizzy", "The suggested header image has been deleted, so the header uses its colour"]);
      // With a deleted logo too, both notes.
      expect(suggestionForReview({ ...banner, headerImageId: "hdr_deleted" }, [], undefined, { images: [], savedImageId: null }).notes)
        .toEqual(["A note from Vizzy", expect.stringMatching(/logo has been deleted/), expect.stringMatching(/header image has been deleted/)]);
    });

    it("with no header image list, the saved header stays, with a note only when the suggestion asked for another", () => {
      expect(suggestionForReview(banner, [logo()], undefined, { images: null, savedImageId: "hdr_spring" })).toMatchObject({
        headerImageId: "hdr_spring",
        notes: ["A note from Vizzy"],
      });
      expect(suggestionForReview(suggestion, [logo()], undefined, { images: null, savedImageId: null })).toMatchObject({
        headerImageId: null,
        notes: ["A note from Vizzy"],
      });
      const other = suggestionForReview(banner, [logo()], undefined, { images: null, savedImageId: "hdr_autumn" });
      expect(other.headerImageId).toBe("hdr_autumn");
      expect(other.notes).toEqual(["A note from Vizzy", expect.stringMatching(/header images couldn't be loaded/)]);
      const colour = suggestionForReview(suggestion, [logo()], undefined, { images: null, savedImageId: "hdr_autumn" });
      expect(colour.headerImageId).toBe("hdr_autumn");
      expect(colour.notes).toHaveLength(2);
    });

    it("with the header options off (no list given), the header is left as it is", () => {
      expect(suggestionForReview(banner, [logo()])).not.toHaveProperty("headerImageId");
    });
  });

  describe("with themes on", () => {
    it("loads the suggested theme with its fonts filled in; none is Classic with the system font", () => {
      const themed = { ...suggestion, theme: { preset: "editorial" as const, headingFont: "playfair-display" as const } };
      expect(suggestionForReview(themed, [logo()], undefined, undefined, true)).toMatchObject({
        headerColor: "#0b1f3a",
        theme: { preset: "editorial", headingFont: "playfair-display", bodyFont: "georgia" },
        notes: ["A note from Vizzy"],
      });
      expect(suggestionForReview(suggestion, [logo()], undefined, undefined, true).theme).toEqual(presetTheme("classic"));
    });

    it("with themes off (not given), the theme is left as it is", () => {
      const themed = { ...suggestion, theme: { preset: "modern" as const } };
      expect(suggestionForReview(themed, [logo()])).not.toHaveProperty("theme");
      expect(suggestionForReview(themed, [logo()], undefined, undefined, false)).not.toHaveProperty("theme");
    });
  });
});

describe("emailStyleSaveInput: what Save sends", () => {
  const LOGO = { id: "logo_1", filename: "3f2504e0-4f89-41d3-9a0c-0305e82c3301.png", width: 120, height: 40 };
  const IMAGE = { id: "hdr_1", filename: "3f2504e0-4f89-41d3-9a0c-0305e82c3302.jpg", width: 1200, height: 300 };
  const draft = {
    companyName: "  Example   Co ",
    headerColor: "#0b1f3a",
    accentColor: "#ff6b35",
    gradient: false,
    headerColor2: "#4f46e5",
    headerText: "auto" as const,
    theme: presetTheme("classic"),
  };

  // Byte for byte what the page sent before themes: JSON.stringify keeps key order, so these are exact.
  it("themes off: today's bodies, with no theme key, whatever the form's theme", () => {
    for (const theme of [presetTheme("classic"), presetTheme("modern"), { ...presetTheme("friendly"), bodyFont: "lora" as const }]) {
      const d = { ...draft, theme };
      expect(JSON.stringify(emailStyleSaveInput(d, { logo: LOGO, headerOptions: false, themes: false }))).toBe(
        `{"logo":${JSON.stringify(LOGO)},"companyName":"Example Co","headerColor":"#0b1f3a","accentColor":"#ff6b35"}`,
      );
      expect(JSON.stringify(emailStyleSaveInput(d, { logo: null, headerOptions: true, headerImage: null, themes: false }))).toBe(
        '{"logo":null,"companyName":"Example Co","headerColor":"#0b1f3a","accentColor":"#ff6b35",' +
          '"headerGradientColor":null,"headerText":"auto","headerImage":null}',
      );
    }
  });

  it("themes off, header options as today: a gradient, a banner, and no image list leaving the image out", () => {
    const d = { ...draft, gradient: true, headerText: "white" as const };
    expect(emailStyleSaveInput(d, { logo: LOGO, headerOptions: true, headerImage: IMAGE, themes: false })).toEqual({
      logo: LOGO,
      companyName: "Example Co",
      headerColor: "#0b1f3a",
      accentColor: "#ff6b35",
      headerGradientColor: "#4f46e5",
      headerText: "white",
      headerImage: IMAGE,
    });
    const unlisted = emailStyleSaveInput(d, { logo: LOGO, headerOptions: true, headerImage: undefined, themes: false });
    expect(unlisted).not.toHaveProperty("headerImage");
    expect(Object.keys(unlisted)).toEqual(["logo", "companyName", "headerColor", "accentColor", "headerGradientColor", "headerText"]);
  });

  it("themes on: the theme last, compacted as it's stored (null = Classic with the system font)", () => {
    const body = (theme: ReturnType<typeof presetTheme>) =>
      emailStyleSaveInput({ ...draft, theme }, { logo: null, headerOptions: true, headerImage: null, themes: true });
    expect(JSON.stringify(body(presetTheme("classic")))).toBe(
      '{"logo":null,"companyName":"Example Co","headerColor":"#0b1f3a","accentColor":"#ff6b35",' +
        '"headerGradientColor":null,"headerText":"auto","headerImage":null,"theme":null}',
    );
    expect(body(presetTheme("modern")).theme).toEqual({ preset: "modern" });
    expect(body({ ...presetTheme("editorial"), headingFont: "playfair-display" }).theme).toEqual({
      preset: "editorial",
      headingFont: "playfair-display",
    });
    expect(body({ ...presetTheme("classic"), bodyFont: "georgia" }).theme).toEqual({ preset: "classic", bodyFont: "georgia" });
    // What the Save API parses strictly.
    expect(EmailStyleInputSchema.safeParse(body({ ...presetTheme("friendly"), headingFont: "inter" })).success).toBe(true);
    expect(
      emailStyleSaveInput({ ...draft, theme: presetTheme("modern") }, { logo: null, headerOptions: false, themes: true }),
    ).toEqual({ logo: null, companyName: "Example Co", headerColor: "#0b1f3a", accentColor: "#ff6b35", theme: { preset: "modern" } });
  });
});

describe("the form's theme", () => {
  it("a look comes with its own fonts", () => {
    expect(presetTheme("classic")).toEqual({ preset: "classic", headingFont: "system", bodyFont: "system" });
    expect(presetTheme("modern")).toEqual({ preset: "modern", headingFont: "inter", bodyFont: "inter" });
    expect(presetTheme("editorial")).toEqual({ preset: "editorial", headingFont: "lora", bodyFont: "georgia" });
    expect(presetTheme("friendly")).toEqual({ preset: "friendly", headingFont: "poppins", bodyFont: "nunito" });
  });

  it("a saved theme fills in the look's own fonts; none, or a damaged one, is Classic", () => {
    expect(themeForForm({ preset: "editorial", bodyFont: "verdana" })).toEqual({
      preset: "editorial",
      headingFont: "lora",
      bodyFont: "verdana",
    });
    expect(themeForForm(null)).toEqual(presetTheme("classic"));
    expect(themeForForm(undefined)).toEqual(presetTheme("classic"));
    expect(themeForForm({ preset: "retro" as never })).toEqual(presetTheme("classic"));
    expect(themeForForm({ preset: "modern", headingFont: "comic-sans" as never })).toEqual(presetTheme("modern"));
  });

  it("the same look and fonts are the same theme", () => {
    expect(sameTheme(presetTheme("modern"), themeForForm({ preset: "modern" }))).toBe(true);
    expect(sameTheme(presetTheme("modern"), { ...presetTheme("modern"), bodyFont: "lora" })).toBe(false);
    expect(sameTheme(presetTheme("classic"), presetTheme("editorial"))).toBe(false);
  });
});

describe("themeLabel", () => {
  it("names the look, then the heading and body fonts; none is Classic", () => {
    expect(themeLabel({ preset: "modern" })).toBe("Modern (Inter / Inter)");
    expect(themeLabel({ preset: "editorial", headingFont: "playfair-display" })).toBe("Editorial (Playfair Display / Georgia)");
    expect(themeLabel({ preset: "friendly", bodyFont: "trebuchet" })).toBe("Friendly (Poppins / Trebuchet MS)");
    expect(themeLabel(null)).toBe("Classic (System / System)");
    expect(themeLabel(undefined)).toBe("Classic (System / System)");
  });
});

describe("emailFontOption: where each font shows", () => {
  it("a safe font shows in every inbox", () => {
    expect(emailFontOption("system", true)).toBe("System — All inboxes");
    expect(emailFontOption("georgia", false)).toBe("Georgia — All inboxes");
    expect(emailFontOption("trebuchet", true)).toBe("Trebuchet MS — All inboxes");
  });

  it("a web font shows in Apple Mail and Outlook for Mac, and others see its safe font", () => {
    expect(emailFontOption("inter", true)).toBe("Inter — Apple Mail & Outlook for Mac · others see Segoe UI or Helvetica");
    expect(emailFontOption("playfair-display", true)).toBe(
      "Playfair Display — Apple Mail & Outlook for Mac · others see Georgia",
    );
  });

  it("with web fonts off, a web font shows as its safe font everywhere", () => {
    expect(emailFontOption("poppins", false)).toBe("Poppins — shows as Segoe UI or Helvetica for now");
    expect(emailFontOption("lora", false)).toBe("Lora — shows as Georgia for now");
  });
});

describe("emailStyleHints with a theme", () => {
  const base = { logoBytes: 10_000, logoInk: "#ffffff", headerColor: "#0b1f3a", accentColor: "#0b1f3a" };
  const theme = (headingFont: string, bodyFont: string, webFonts: boolean) =>
    ({ theme: { headingFont, bodyFont, webFonts } }) as Pick<Parameters<typeof emailStyleHints>[0], "theme">;

  it("safe fonts add nothing, and no theme is as before", () => {
    expect(emailStyleHints({ ...base, ...theme("system", "system", true) })).toEqual([]);
    expect(emailStyleHints({ ...base, ...theme("georgia", "verdana", false) })).toEqual([]);
    expect(emailStyleHints(base)).toEqual([]);
  });

  it("with web fonts on: what Gmail and Outlook.com show instead, each font once, last", () => {
    expect(emailStyleHints({ ...base, ...theme("inter", "inter", true) })).toEqual([
      "Gmail, Outlook.com and most other inboxes show Segoe UI or Helvetica in place of Inter — see “As Gmail & Outlook.com see it”",
    ]);
    expect(emailStyleHints({ ...base, ...theme("lora", "poppins", true) })).toEqual([
      "Gmail, Outlook.com and most other inboxes show Georgia and Segoe UI or Helvetica in place of Lora and Poppins — see “As Gmail & Outlook.com see it”",
    ]);
    expect(emailStyleHints({ ...base, ...theme("poppins", "nunito", true) })[0]).toMatch(
      /show Segoe UI or Helvetica in place of Poppins and Nunito/,
    );
    // After the style's own hints.
    expect(emailStyleHints({ ...base, accentColor: "#FFD400", ...theme("lora", "georgia", true) })).toEqual([
      expect.stringMatching(/too light for text links/),
      expect.stringMatching(/show Georgia in place of Lora/),
    ]);
  });

  it("with web fonts off: every inbox shows the safe font", () => {
    expect(emailStyleHints({ ...base, ...theme("system", "montserrat", false) })).toEqual([
      "Web fonts aren't switched on yet, so every inbox shows Segoe UI or Helvetica in place of Montserrat",
    ]);
  });

  it("in Image mode too, after the banner's hints", () => {
    expect(
      emailStyleHints({
        ...base,
        headerImage: { width: 1200, height: 300, byteSize: 10_000 },
        ...theme("playfair-display", "arial", true),
      }),
    ).toEqual([expect.stringMatching(/show Georgia in place of Playfair Display/)]);
  });
});

describe("emailFontForFamily", () => {
  it("matches an email font by its name or id, ignoring case and weight words", () => {
    expect(emailFontForFamily("Inter")).toBe("inter");
    expect(emailFontForFamily("inter")).toBe("inter");
    expect(emailFontForFamily("Playfair Display")).toBe("playfair-display");
    expect(emailFontForFamily("playfair-display")).toBe("playfair-display");
    expect(emailFontForFamily("Trebuchet MS")).toBe("trebuchet");
    expect(emailFontForFamily("Trebuchet")).toBe("trebuchet");
    expect(emailFontForFamily("Montserrat Semi Bold")).toBe("montserrat");
    expect(emailFontForFamily("Lora Italic")).toBe("lora");
    expect(emailFontForFamily("System")).toBe("system");
  });

  it("anything else isn't an email font", () => {
    expect(emailFontForFamily("Interstate")).toBeNull();
    expect(emailFontForFamily("Open Sans")).toBeNull();
    expect(emailFontForFamily("Playfair")).toBeNull();
    expect(emailFontForFamily("Bold")).toBeNull();
    expect(emailFontForFamily("  ")).toBeNull();
  });
});

describe("brandFontsToEmail: Use brand fonts", () => {
  const style = (role: TextStyle["role"], fontFamily: string | null): TextStyle => ({
    id: `ts_${role}`,
    name: role,
    role,
    fontFamily,
    size: 16,
  });

  it("a Heading style for headings, a Body style for text", () => {
    expect(brandFontsToEmail({ styles: [style("body", "Nunito"), style("heading", "Montserrat")] }, ["Lora"])).toEqual({
      headingFont: "montserrat",
      bodyFont: "nunito",
      notes: [],
    });
  });

  it("a Title style when there's no Heading one; styles with no font don't count", () => {
    expect(
      brandFontsToEmail({ styles: [style("heading", null), style("title", "Playfair Display"), style("body", "Georgia")] }, null),
    ).toEqual({ headingFont: "playfair-display", bodyFont: "georgia", notes: [] });
  });

  it("then the guideline fonts: the first for headings, the second (else the first) for text", () => {
    expect(brandFontsToEmail(null, ["Poppins", "Inter"])).toEqual({ headingFont: "poppins", bodyFont: "inter", notes: [] });
    expect(brandFontsToEmail({ styles: [] }, ["Lora"])).toEqual({ headingFont: "lora", bodyFont: "lora", notes: [] });
    expect(brandFontsToEmail({ styles: [style("heading", "Lora")] }, ["Montserrat", "Inter"])).toMatchObject({
      headingFont: "lora",
      bodyFont: "inter",
    });
  });

  it("one brand font is used for both", () => {
    expect(brandFontsToEmail({ styles: [style("body", "Inter")] }, [])).toEqual({ headingFont: "inter", bodyFont: "inter", notes: [] });
    expect(brandFontsToEmail({ styles: [style("title", "Lora")] }, [])).toMatchObject({ headingFont: "lora", bodyFont: "lora" });
  });

  it("a font email doesn't have (an uploaded one, say) keeps the form's, with a note", () => {
    expect(brandFontsToEmail({ styles: [style("heading", "Example Sans"), style("body", "Inter")] }, [])).toEqual({
      headingFont: null,
      bodyFont: "inter",
      notes: ["“Example Sans” isn't available for email yet, so headings keep the current font"],
    });
    expect(brandFontsToEmail({ styles: [style("heading", "Lora"), style("body", "Open Sans")] }, [])).toEqual({
      headingFont: "lora",
      bodyFont: null,
      notes: ["“Open Sans” isn't available for email yet, so text keeps the current font"],
    });
    expect(brandFontsToEmail(null, ["Example Sans"])).toEqual({
      headingFont: null,
      bodyFont: null,
      notes: ["“Example Sans” isn't available for email yet, so headings and text keep the current font"],
    });
    expect(brandFontsToEmail(null, ["Example Serif", "Example Sans"]).notes).toHaveLength(2);
  });

  it("no brand fonts at all says where to add them", () => {
    for (const [typography, kit] of [
      [null, null],
      [{ styles: [style("heading", null), style("caption", "Inter")] }, ["  "]],
    ] as const) {
      expect(brandFontsToEmail(typography, kit)).toEqual({
        headingFont: null,
        bodyFont: null,
        notes: ["No brand fonts yet — add text styles in Brand › Fonts"],
      });
    }
  });
});

describe("isBrandFontNote", () => {
  it("knows Use brand fonts' notes, and nothing else", () => {
    const style = (role: TextStyle["role"], fontFamily: string): TextStyle => ({ id: `ts_${role}`, name: role, role, fontFamily });
    const notes = [
      ...brandFontsToEmail(null, null).notes,
      ...brandFontsToEmail({ styles: [style("heading", "Example Serif"), style("body", "Example Sans")] }, null).notes,
      ...brandFontsToEmail({ styles: [style("heading", "Example Serif")] }, null).notes,
    ];
    expect(notes).toHaveLength(4);
    for (const n of notes) expect(isBrandFontNote(n)).toBe(true);
    for (const n of [
      "An earlier note",
      "No logos yet — add a PNG or JPG in Brand › Logos",
      "Your header image is no longer available — upload or pick one in Brand › Email style",
      "Your chosen logo is no longer available — pick another in Brand › Email style",
      "isn't available for email yet",
    ]) {
      expect(isBrandFontNote(n)).toBe(false);
    }
  });
});

describe("the page's own web fonts (the theme tiles)", () => {
  it("a bold face for each web font, from this origin, under the page's own family names", () => {
    const css = pageWebFontFaces();
    const faces = css.split("\n");
    expect(faces).toHaveLength(6);
    expect(faces[0]).toBe(
      "@font-face{font-family:'Email Inter';font-style:normal;font-weight:700;" +
        "src:url(/email-fonts/inter-700.v1.woff2) format('woff2');font-display:swap}",
    );
    expect(css).toContain("url(/email-fonts/playfair-display-700.v1.woff2)");
    expect(css).not.toContain("?");
    expect(css).not.toMatch(/https?:/);
  });

  it("draws a web font in its own family only with web fonts on; a safe font as its stack", () => {
    expect(pageFontStack("inter", true)).toBe("'Email Inter','Segoe UI',Helvetica,Arial,sans-serif");
    expect(pageFontStack("inter", false)).toBe("'Segoe UI',Helvetica,Arial,sans-serif");
    expect(pageFontStack("lora", true)).toBe("'Email Lora',Georgia,'Times New Roman',Times,serif");
    expect(pageFontStack("georgia", true)).toBe("Georgia,'Times New Roman',Times,serif");
  });
});
