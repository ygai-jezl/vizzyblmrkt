import { describe, it, expect } from "vitest";
import { EMAIL_THEME_PRESETS } from "@/lib/types/tenant";
import { compactTheme, EMAIL_THEME_PRESET_SPECS, isEmailThemePreset, PILL_RADIUS, themeTokens, tint } from "./emailThemes";

const theme = (preset: (typeof EMAIL_THEME_PRESETS)[number]) =>
  ({ preset, headingFont: "system", bodyFont: "system" }) as const;

describe("the presets", () => {
  it("has the four looks, with their own fonts", () => {
    expect(Object.keys(EMAIL_THEME_PRESET_SPECS)).toEqual([...EMAIL_THEME_PRESETS]);
    const fonts = Object.values(EMAIL_THEME_PRESET_SPECS).map((p) => [p.label, p.headingFont, p.bodyFont]);
    expect(fonts).toEqual([
      ["Classic", "system", "system"],
      ["Modern", "inter", "inter"],
      ["Editorial", "lora", "georgia"],
      ["Friendly", "poppins", "nunito"],
    ]);
  });

  it("isEmailThemePreset takes the four ids only", () => {
    for (const p of EMAIL_THEME_PRESETS) expect(isEmailThemePreset(p)).toBe(true);
    for (const p of ["Modern", "brutalist", "toString", "", null]) expect(isEmailThemePreset(p)).toBe(false);
  });
});

describe("themeTokens", () => {
  const accentColor = "#4f46e5";

  it("no style or no theme → null (today's markup)", () => {
    expect(themeTokens(null)).toBeNull();
    expect(themeTokens(undefined)).toBeNull();
    expect(themeTokens({ accentColor })).toBeNull();
  });

  it("each look's page, corners, button shape, padding and line height", () => {
    expect(themeTokens({ accentColor, theme: theme("classic") })).toEqual({
      pageColor: "#f6f6f6",
      cardRadius: 0,
      buttonRadius: 8,
      padY: 24,
      lineHeight: 1.6,
    });
    expect(themeTokens({ accentColor, theme: theme("modern") })).toEqual({
      pageColor: "#f3f4f6",
      cardRadius: 12,
      buttonRadius: PILL_RADIUS,
      padY: 32,
      lineHeight: 1.6,
    });
    expect(themeTokens({ accentColor, theme: theme("editorial") })).toEqual({
      pageColor: "#f7f3ec",
      cardRadius: 0,
      buttonRadius: 0,
      padY: 32,
      lineHeight: 1.7,
    });
    expect(themeTokens({ accentColor, theme: theme("friendly") })).toEqual({
      pageColor: "#f4f4fd",
      cardRadius: 16,
      buttonRadius: PILL_RADIUS,
      padY: 28,
      lineHeight: 1.65,
    });
  });

  it("Friendly's page is a 94% tint of the style's own button colour, so another button colour gets its own", () => {
    expect(themeTokens({ accentColor: "#ff6b35", theme: theme("friendly") })!.pageColor).toBe("#fff6f3");
    expect(themeTokens({ accentColor: "#000000", theme: theme("friendly") })!.pageColor).toBe("#f0f0f0");
    // The other looks ignore it.
    expect(themeTokens({ accentColor: "#ff6b35", theme: theme("modern") })!.pageColor).toBe("#f3f4f6");
  });

  it("an unknown preset (a style built by hand) → null", () => {
    const style = { accentColor, theme: { preset: "brutalist" } } as unknown as Parameters<typeof themeTokens>[0];
    expect(themeTokens(style)).toBeNull();
  });
});

describe("tint", () => {
  it("mixes toward white, and falls back to Classic's page for a non-colour", () => {
    expect(tint("#4F46E5", 0.94)).toBe("#f4f4fd");
    expect(tint("#123456", 0)).toBe("#123456");
    expect(tint("#123456", 1)).toBe("#ffffff");
    expect(tint("navy", 0.94)).toBe("#f6f6f6");
    expect(tint(null, 0.94)).toBe("#f6f6f6");
  });
});

describe("compactTheme", () => {
  it("leaves out the preset's own fonts", () => {
    expect(compactTheme({ preset: "modern", headingFont: "inter", bodyFont: "inter" })).toEqual({ preset: "modern" });
    expect(compactTheme({ preset: "editorial", headingFont: "playfair-display", bodyFont: "georgia" })).toEqual({
      preset: "editorial",
      headingFont: "playfair-display",
    });
    expect(compactTheme({ preset: "friendly", bodyFont: "arial" })).toEqual({ preset: "friendly", bodyFont: "arial" });
  });

  it("Classic with the system font, or nothing, is no theme", () => {
    expect(compactTheme({ preset: "classic" })).toBeNull();
    expect(compactTheme({ preset: "classic", headingFont: "system", bodyFont: "system" })).toBeNull();
    expect(compactTheme(null)).toBeNull();
    expect(compactTheme(undefined)).toBeNull();
    expect(compactTheme({ preset: "classic", bodyFont: "georgia" })).toEqual({ preset: "classic", bodyFont: "georgia" });
  });
});
