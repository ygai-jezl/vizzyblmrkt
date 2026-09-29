import { EMAIL_THEME_PRESETS, type EmailFontId, type EmailTheme, type EmailThemePreset } from "@/lib/types/tenant";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import type { ResolvedEmailStyle } from "./emailStyle";

/**
 * Email themes — the four looks a theme starts from. Pure + client-safe (no env, no server
 * imports). Code only: a stored theme is a preset and two font ids, never CSS or colours, so a
 * look can be tuned here and every email that uses it follows.
 *
 * The card stays 608 wide in every look (24px each side), so it lines up with the header band.
 * Headings are always bold, so each web font ships 400 and 700 only.
 */

/** A pill: a radius bigger than any button is tall. */
export const PILL_RADIUS = 999;

/** What the renderers draw for a theme, besides its fonts. */
export interface EmailThemeTokens {
  /** Behind the card (a wrapper table, since some inboxes drop or replace `<body>`). */
  pageColor: string;
  /** 0 = square. */
  cardRadius: number;
  /** 0 = square; PILL_RADIUS = a pill. */
  buttonRadius: number;
  /** The card's top and bottom padding. */
  padY: number;
  lineHeight: number;
}

export interface EmailThemePresetSpec extends Omit<EmailThemeTokens, "pageColor"> {
  label: string;
  headingFont: EmailFontId;
  bodyFont: EmailFontId;
  /** A #rrggbb, or "tint": a 94% tint of the email's own button colour. */
  page: string;
}

export const EMAIL_THEME_PRESET_SPECS: Readonly<Record<EmailThemePreset, EmailThemePresetSpec>> = {
  classic: {
    label: "Classic",
    headingFont: "system",
    bodyFont: "system",
    page: "#f6f6f6",
    cardRadius: 0,
    buttonRadius: 8,
    padY: 24,
    lineHeight: 1.6,
  },
  modern: {
    label: "Modern",
    headingFont: "inter",
    bodyFont: "inter",
    page: "#f3f4f6",
    cardRadius: 12,
    buttonRadius: PILL_RADIUS,
    padY: 32,
    lineHeight: 1.6,
  },
  editorial: {
    label: "Editorial",
    headingFont: "lora",
    bodyFont: "georgia",
    page: "#f7f3ec",
    cardRadius: 0,
    buttonRadius: 0,
    padY: 32,
    lineHeight: 1.7,
  },
  friendly: {
    label: "Friendly",
    headingFont: "poppins",
    bodyFont: "nunito",
    page: "tint",
    cardRadius: 16,
    buttonRadius: PILL_RADIUS,
    padY: 28,
    lineHeight: 1.65,
  },
};

export function isEmailThemePreset(preset: unknown): preset is EmailThemePreset {
  return typeof preset === "string" && (EMAIL_THEME_PRESETS as readonly string[]).includes(preset);
}

/**
 * The theme's tokens, or null with no theme (today's markup). Friendly's page is tinted from the
 * style's own button colour, so a style with another button colour gets its own tint.
 */
export function themeTokens(
  style: Pick<ResolvedEmailStyle, "theme" | "accentColor"> | null | undefined,
): EmailThemeTokens | null {
  const preset = style?.theme?.preset;
  if (!isEmailThemePreset(preset)) return null;
  const { page, cardRadius, buttonRadius, padY, lineHeight } = EMAIL_THEME_PRESET_SPECS[preset];
  return {
    pageColor: page === "tint" ? tint(style!.accentColor, 0.94) : page,
    cardRadius,
    buttonRadius,
    padY,
    lineHeight,
  };
}

/**
 * The corners a Create layout button that follows the Email style takes from the theme, or null
 * to keep its own. Classic is today's look, so with any fonts it leaves each button's own corners
 * (its 8px is only the default of the buttons the renderers draw themselves).
 */
export function layoutButtonRadius(
  style: Pick<ResolvedEmailStyle, "theme" | "accentColor"> | null | undefined,
): number | null {
  const tokens = themeTokens(style);
  return tokens && style?.theme?.preset !== "classic" ? tokens.buttonRadius : null;
}

/** `amount` of the way from `hex` to white; Classic's page colour when `hex` isn't a colour. */
export function tint(hex: string | null | undefined, amount: number): string {
  const h = normalizeHex(hex);
  if (!h) return EMAIL_THEME_PRESET_SPECS.classic.page;
  return `#${[1, 3, 5]
    .map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16);
      return Math.round(c + (255 - c) * amount)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/**
 * A theme as it's stored: fonts equal to the preset's are left out (absent = the preset's), and
 * Classic with its own fonts is no theme at all (null), since that's today's look.
 */
export function compactTheme(theme: EmailTheme | null | undefined): EmailTheme | null {
  if (!theme) return null;
  const spec = EMAIL_THEME_PRESET_SPECS[theme.preset];
  const headingFont = theme.headingFont && theme.headingFont !== spec.headingFont ? theme.headingFont : undefined;
  const bodyFont = theme.bodyFont && theme.bodyFont !== spec.bodyFont ? theme.bodyFont : undefined;
  if (theme.preset === "classic" && !headingFont && !bodyFont) return null;
  return { preset: theme.preset, ...(headingFont ? { headingFont } : {}), ...(bodyFont ? { bodyFont } : {}) };
}
