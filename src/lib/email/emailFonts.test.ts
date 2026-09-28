import { describe, it, expect } from "vitest";
import { EMAIL_FONT_IDS } from "@/lib/types/tenant";
import { EMAIL_FONT_LIST, EMAIL_FONTS, FONT, fontFor, isEmailFontId, isWebFont } from "./emailFonts";

const WEB_FAMILIES = ["Inter", "Poppins", "Nunito", "Montserrat", "Lora", "Playfair Display"];

describe("the font table", () => {
  it("FONT is today's stack, byte for byte", () => {
    expect(FONT).toBe("system-ui,-apple-system,Segoe UI,Roboto,sans-serif");
    expect(EMAIL_FONTS.system.safeStack).toBe(FONT);
  });

  it("has every id, in order, each under its own key", () => {
    expect(Object.keys(EMAIL_FONTS).sort()).toEqual([...EMAIL_FONT_IDS].sort());
    expect(EMAIL_FONT_LIST.map((f) => f.id)).toEqual([...EMAIL_FONT_IDS]);
    for (const [key, font] of Object.entries(EMAIL_FONTS)) expect(font.id).toBe(key);
  });

  it("ships six web families, and five safe fonts", () => {
    expect(EMAIL_FONT_LIST.flatMap((f) => (f.web ? [f.web.family] : []))).toEqual(WEB_FAMILIES);
    expect(EMAIL_FONT_LIST.filter((f) => !f.web).map((f) => f.label)).toEqual([
      "System",
      "Arial",
      "Georgia",
      "Verdana",
      "Trebuchet MS",
    ]);
  });

  it("every safe stack ends in a generic family and never names a web family", () => {
    for (const font of EMAIL_FONT_LIST) {
      expect(font.safeStack).toMatch(/,(sans-serif|serif)$/);
      for (const family of WEB_FAMILIES) expect(font.safeStack).not.toContain(family);
      // Inline in style="…", so no double quotes.
      expect(font.safeStack).not.toContain('"');
    }
  });

  it("a web font's safe stack is the one its fallback names", () => {
    expect(EMAIL_FONTS.inter.safeStack).toBe("'Segoe UI',Helvetica,Arial,sans-serif");
    expect(EMAIL_FONTS.inter.web?.fallback).toBe("Segoe UI or Helvetica");
    expect(EMAIL_FONTS.lora.safeStack).toBe("Georgia,'Times New Roman',Times,serif");
    for (const font of EMAIL_FONT_LIST) {
      if (!font.web) continue;
      // The fonts it names are the ones the stack leads with, so the page never names one an inbox skips.
      const named = font.web.fallback.split(" or ").map((name) => (name.includes(" ") ? `'${name}'` : name));
      expect(font.safeStack.startsWith(`${named.join(",")},`)).toBe(true);
      expect(font.safeStack).toBe(font.web.fallback === "Georgia" ? EMAIL_FONTS.georgia.safeStack : EMAIL_FONTS.inter.safeStack);
    }
  });

  it("isEmailFontId takes ids only, never CSS or inherited keys", () => {
    expect(isEmailFontId("playfair-display")).toBe(true);
    for (const id of ["Inter", "'Inter',sans-serif", "toString", "__proto__", "", null, 1]) expect(isEmailFontId(id)).toBe(false);
    expect(isWebFont("inter")).toBe(true);
    expect(isWebFont("georgia")).toBe(false);
  });
});

describe("fontFor", () => {
  it("no style or no theme → today's FONT for both", () => {
    expect(fontFor(null, "body")).toBe(FONT);
    expect(fontFor(undefined, "heading")).toBe(FONT);
    expect(fontFor({}, "heading")).toBe(FONT);
  });

  it("a theme → each role's safe stack, never the web family inline", () => {
    const style = { theme: { preset: "editorial", headingFont: "lora", bodyFont: "verdana" } as const };
    expect(fontFor(style, "heading")).toBe("Georgia,'Times New Roman',Times,serif");
    expect(fontFor(style, "body")).toBe("Verdana,Geneva,sans-serif");
  });

  it("an id it doesn't know (a style built by hand) → today's FONT", () => {
    const style = { theme: { preset: "modern", headingFont: "comic-sans", bodyFont: "inter" } } as unknown as Parameters<
      typeof fontFor
    >[0];
    expect(fontFor(style, "heading")).toBe(FONT);
    expect(fontFor(style, "body")).toBe(EMAIL_FONTS.inter.safeStack);
  });
});
