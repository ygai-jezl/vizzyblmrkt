import {
  EMAIL_HEADER_IMAGE_LIMITS,
  EMAIL_LOGO_FILENAME,
  EMAIL_STYLE_LIMITS,
  HIDDEN_NAME_CHARS,
  type BrandKit,
  type EmailFontId,
  type EmailStyleInput,
  type EmailThemePreset,
  type StoredJourneyStyle,
} from "@/lib/types/tenant";
import type { BrandLogo } from "@/lib/types/brandLogo";
import type { BrandAsset } from "@/lib/types/brandAsset";
import { normalizeHex } from "@/lib/content/create/colorPalette";
import { isEmailFontId, isWebFont } from "./emailFonts";
import { EMAIL_THEME_PRESET_SPECS, isEmailThemePreset } from "./emailThemes";

/**
 * Email style — the pure half. Pure + client-safe (no env, no server imports): shared by
 * the server resolver (resolveEmailStyle.ts), the renderers and the Brand › Email style
 * page's live preview. A `null` style everywhere means today's look, byte for byte.
 */

/** What the renderers draw. `null` instead of this = no style (today's output). */
export interface ResolvedEmailStyle {
  /** A checked, absolute logo URL with its display size; null = a name-only band. */
  logo: { url: string; width: number; height: number } | null;
  /** Shown beside the logo; null = the logo alone. */
  name: string | null;
  /** The logo's alt text, and the band's text when there's no logo. */
  altName: string;
  headerColor: string;
  accentColor: string;
  /** The band fades from headerColor to this (top left to bottom right); absent = solid. */
  headerGradientColor?: string;
  /** The band's text colour, forced; absent = Auto (whichever reads better across the band). */
  headerText?: "white" | "black";
  /**
   * A checked, absolute header image URL with its pixel size: a full-width banner in place of
   * the logo and name, on the header colour. Absent = the colour header (logo, name, gradient).
   */
  headerImage?: { url: string; width: number; height: number };
  /**
   * A look (page colour, corners, button shape, spacing: themeTokens in emailThemes.ts) and two
   * font ids (fontFor in emailFonts.ts). It holds no colours, so a style's own button colour
   * tints Friendly's page. `webFontOrigin` (https) is where the web font files are, set only when
   * web fonts are on and one of the two is a web font. Absent = Classic with the system font.
   */
  theme?: { preset: EmailThemePreset; headingFont: EmailFontId; bodyFont: EmailFontId; webFontOrigin?: string };
  /**
   * Buttons in a Create email layout follow this style: the button colour with a readable label,
   * and the theme's button shape (Classic keeps each button's own corners). A button set to its
   * own colour doesn't. Absent = every layout button as built.
   */
  layouts?: true;
}

/**
 * Map a saved (or, on the page, unsaved) style to what the renderers draw. The caller
 * supplies the logo URL — the server resolver checks it's this tenant's; the page builds
 * a preview one — and the name to fall back on (the footer's sender brand).
 *
 * The header options are only read with `headerOptions` (the caller's flag), and only a
 * real one is set: no gradient, a gradient equal to the header colour and Auto text leave
 * the keys out, so the result is exactly what it was without them. A header image is set
 * only when `headerImageUrlFor` (checked by the caller, like the logo's) gives a URL; the
 * gradient and text keys stay alongside it, for when the image is dropped.
 *
 * The theme works the same way with `themes`: Classic with the system font, an unknown preset
 * or no theme leave the key out. An unknown font is the preset's. With `webFonts`, a theme with
 * a web font gets `fontOrigin` (only an https one) as its `webFontOrigin`.
 *
 * `layouts` (the caller's flag) sets the bit that makes layout buttons follow the style.
 */
export function resolveStoredStyle(
  stored:
    | Pick<
        EmailStyleInput,
        | "logo"
        | "companyName"
        | "headerColor"
        | "accentColor"
        | "headerGradientColor"
        | "headerText"
        | "headerImage"
        | "theme"
      >
    | null
    | undefined,
  opts: {
    logoUrlFor: (logo: { id: string; filename: string }) => string | null;
    headerImageUrlFor?: (image: { id: string; filename: string }) => string | null;
    fallbackName: string;
    headerOptions?: boolean;
    themes?: boolean;
    webFonts?: boolean;
    fontOrigin?: string;
    layouts?: boolean;
  },
): ResolvedEmailStyle | null {
  if (!stored) return null;
  const headerColor = normalizeHex(stored.headerColor);
  const accentColor = normalizeHex(stored.accentColor);
  if (!headerColor || !accentColor) return null;
  const name = cleanCompanyName(stored.companyName);
  const url = stored.logo ? opts.logoUrlFor(stored.logo) : null;
  const gradient = opts.headerOptions ? normalizeHex(stored.headerGradientColor) : null;
  const text =
    opts.headerOptions && (stored.headerText === "white" || stored.headerText === "black") ? stored.headerText : null;
  const image = opts.headerOptions && stored.headerImage ? stored.headerImage : null;
  const imageUrl = image && opts.headerImageUrlFor ? opts.headerImageUrlFor(image) : null;
  const theme = opts.themes ? resolveTheme(stored.theme, opts) : null;
  return {
    logo:
      url && stored.logo
        ? {
            url,
            width: clampInt(stored.logo.width, EMAIL_STYLE_LIMITS.logoWidth),
            height: clampInt(stored.logo.height, EMAIL_STYLE_LIMITS.logoHeight),
          }
        : null,
    name,
    altName: name ?? cleanCompanyName(opts.fallbackName) ?? "",
    headerColor,
    accentColor,
    ...(gradient && gradient !== headerColor ? { headerGradientColor: gradient } : {}),
    ...(text ? { headerText: text } : {}),
    ...(image && imageUrl
      ? {
          headerImage: {
            url: imageUrl,
            width: clampInt(image.width, EMAIL_HEADER_IMAGE_LIMITS.width),
            height: clampInt(image.height, EMAIL_HEADER_IMAGE_LIMITS.height),
          },
        }
      : {}),
    ...(theme ? { theme } : {}),
    ...(opts.layouts ? { layouts: true as const } : {}),
  };
}

/**
 * The style with the colour header (logo, name, gradient) in place of any header image. The
 * sign-up confirmation and offboarding emails draw this: a banner can fill a 608px square
 * above the one button that matters. Without a header image it's the same style.
 */
export function withoutHeaderImage(style: ResolvedEmailStyle | null): ResolvedEmailStyle | null {
  if (!style?.headerImage) return style;
  const { headerImage, ...rest } = style;
  return rest;
}

/**
 * A journey's own look over the brand's resolved style (`base`), as its sends and previews draw
 * it. Shared by the server (resolveJourneyEmailStyle) and the journey editor's preview. The
 * journey's header and button colours, gradient and header text (these two only with
 * `headerOptions`, the caller's flag) on the colour header, with the brand's logo, name, theme and
 * layout bit. Never the brand's banner, gradient or text colour: a Custom journey draws only its
 * own header. A theme holds no colours, so Friendly's page tints from the journey's button colour.
 *
 * No override, or one whose colours don't read, is `base` itself (the same object). With no brand
 * style, the journey's colours on a name band (`fallbackName`, as the brand's would use).
 */
export function applyJourneyStyle(
  base: ResolvedEmailStyle | null,
  override: StoredJourneyStyle | null | undefined,
  opts: { fallbackName: string; headerOptions?: boolean },
): ResolvedEmailStyle | null {
  if (!override) return base;
  const own = resolveStoredStyle(
    {
      logo: null,
      companyName: base?.name ?? null,
      headerColor: override.headerColor,
      accentColor: override.accentColor,
      headerGradientColor: override.headerGradientColor,
      headerText: override.headerText,
    },
    { logoUrlFor: () => null, fallbackName: opts.fallbackName, headerOptions: opts.headerOptions },
  );
  if (!own) return base;
  if (!base) return own;
  return {
    ...own,
    logo: base.logo,
    altName: base.altName,
    ...(base.theme ? { theme: base.theme } : {}),
    ...(base.layouts ? { layouts: true as const } : {}),
  };
}

/** A saved (or unsaved) theme as the renderers draw it; null = none (Classic with the system font). */
function resolveTheme(
  raw: unknown,
  opts: { webFonts?: boolean; fontOrigin?: string },
): NonNullable<ResolvedEmailStyle["theme"]> | null {
  if (!raw || typeof raw !== "object") return null;
  const { preset, headingFont, bodyFont } = raw as { preset?: unknown; headingFont?: unknown; bodyFont?: unknown };
  if (!isEmailThemePreset(preset)) return null;
  const spec = EMAIL_THEME_PRESET_SPECS[preset];
  const heading = isEmailFontId(headingFont) ? headingFont : spec.headingFont;
  const body = isEmailFontId(bodyFont) ? bodyFont : spec.bodyFont;
  if (preset === "classic" && heading === "system" && body === "system") return null;
  const origin = opts.webFonts && (isWebFont(heading) || isWebFont(body)) ? httpsOrigin(opts.fontOrigin) : null;
  return { preset, headingFont: heading, bodyFont: body, ...(origin ? { webFontOrigin: origin } : {}) };
}

/** An https origin (no credentials), or null: an inbox won't load fonts from anything else. */
function httpsOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

function clampInt(n: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.round(n))) : max;
}

// ── Contrast (WCAG 2) ────────────────────────────────────────────────────────

/** Relative luminance of a colour, 0 (black) to 1 (white). Anything unparseable counts as black. */
export function luminance(hex: string): number {
  const h = normalizeHex(hex) ?? "#000000";
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `bg` — never below 4.58:1. */
export function readableOn(bg: string): "#000000" | "#ffffff" {
  return contrastRatio(bg, "#000000") >= contrastRatio(bg, "#ffffff") ? "#000000" : "#ffffff";
}

/**
 * Black or white, whichever has the better WORST contrast across `bgs` (a gradient's stops).
 * A tie goes to black, as in readableOn, so for one colour it's exactly readableOn.
 */
export function readableAcross(bgs: readonly string[]): "#000000" | "#ffffff" {
  const worst = (ink: string) => Math.min(...bgs.map((bg) => contrastRatio(bg, ink)));
  return worst("#000000") >= worst("#ffffff") ? "#000000" : "#ffffff";
}

// ── The header band's colours ────────────────────────────────────────────────

type BandColours = Pick<ResolvedEmailStyle, "headerColor" | "headerGradientColor" | "headerText">;

/** The renderer's safeHex check, repeated here because emailRender imports this file. */
const BAND_HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The colours the band actually draws: the header colour (#111111 if it isn't #rrggbb),
 * then colour 2 when it's a #rrggbb that differs from it. The text is judged against these,
 * so it's never judged against a colour that isn't drawn.
 */
export function bandStops(style: BandColours): [string] | [string, string] {
  const bg = BAND_HEX.test(style.headerColor) ? style.headerColor : "#111111";
  const bg2 = style.headerGradientColor;
  return bg2 && BAND_HEX.test(bg2) && bg2.toLowerCase() !== bg.toLowerCase() ? [bg, bg2] : [bg];
}

/** The band's text colour: the forced one, else whichever reads better across its stops. */
export function bandInk(style: BandColours): "#000000" | "#ffffff" {
  if (style.headerText === "white") return "#ffffff";
  if (style.headerText === "black") return "#000000";
  return readableAcross(bandStops(style));
}

/** The band text's worst contrast across the stops. The page warns below 3:1 (it's 18px bold). */
export function bandTextContrast(style: BandColours): number {
  const ink = bandInk(style);
  return Math.min(...bandStops(style).map((bg) => contrastRatio(bg, ink)));
}

/**
 * The accent colour for one use, or null to keep today's #111. Buttons always take it
 * (their label uses readableOn); links need 4.5:1 on the white card; the insight rule
 * needs 3:1 on the #f6f6f6 panel.
 */
export function accentFor(
  style: Pick<ResolvedEmailStyle, "accentColor"> | null | undefined,
  use: "button" | "link" | "rule",
): string | null {
  const accent = normalizeHex(style?.accentColor);
  if (!accent) return null;
  if (use === "link") return contrastRatio(accent, "#ffffff") >= 4.5 ? accent : null;
  if (use === "rule") return contrastRatio(accent, "#f6f6f6") >= 3 ? accent : null;
  return accent;
}

// ── Image URLs (logos, header images) ────────────────────────────────────────

const LOGO_PATH = /^\/api\/brand-logo\/([^/]+)\/([^/]+)$/;
const HEADER_IMAGE_PATH = /^\/api\/brand-asset\/header\/([^/]+)\/([^/]+)$/;

/** https, one of our public image routes (`path`), a PNG/JPEG file, and nothing else (no query, hash or credentials). */
function parseImageUrl(url: string, path: RegExp): { href: string; tenantSegment: string } | null {
  if (typeof url !== "string" || /[?#\s\\]/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  const m = path.exec(u.pathname);
  if (!m || !EMAIL_LOGO_FILENAME.test(m[2]!)) return null;
  return { href: u.href, tenantSegment: m[1]! };
}

/** The tenant-agnostic check — what the shell can repeat in the browser for previews. */
export function isLogoUrlShape(url: string): boolean {
  return parseImageUrl(url, LOGO_PATH) !== null;
}

/** The full check, run once by the server resolver: the logo must be THIS tenant's. */
export function safeLogoUrl(url: string, tenantId: string): string | null {
  const parsed = parseImageUrl(url, LOGO_PATH);
  return parsed && parsed.tenantSegment === encodeURIComponent(tenantId) ? parsed.href : null;
}

/** The tenant-agnostic check for a header image (the public /api/brand-asset/header/… route). */
export function isHeaderImageUrlShape(url: string): boolean {
  return parseImageUrl(url, HEADER_IMAGE_PATH) !== null;
}

/** The full check, run once by the server resolver: the header image must be THIS tenant's. */
export function safeHeaderImageUrl(url: string, tenantId: string): string | null {
  const parsed = parseImageUrl(url, HEADER_IMAGE_PATH);
  return parsed && parsed.tenantSegment === encodeURIComponent(tenantId) ? parsed.href : null;
}

// ── Company name ─────────────────────────────────────────────────────────────

const HIDDEN_NAME_CHARS_ALL = new RegExp(HIDDEN_NAME_CHARS, "gu");
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/;

/**
 * Tidy a company name before it's validated: line breaks become spaces, control and
 * invisible-format characters (e.g. U+2063, U+202E) go, and it's clipped to 80. Null when
 * blank. Markup ({{, *|, <) is left for CompanyNameSchema to reject, so the admin sees why.
 */
export function cleanCompanyName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw
    .replace(HIDDEN_NAME_CHARS_ALL, (c) => (LINE_BREAKS.test(c) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > EMAIL_STYLE_LIMITS.companyName) {
    // Don't leave half a surrogate pair at the cut.
    s = s.slice(0, EMAIL_STYLE_LIMITS.companyName).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  }
  return s || null;
}

// ── "Use brand kit" ──────────────────────────────────────────────────────────

/** "Use brand kit": the style Brand suggests, and why anything is missing. The page measures the logo. */
export interface BrandKitEmailStyle {
  logoId: string | null;
  companyName: string | null;
  headerColor: string;
  accentColor: string;
  notes: string[];
}

export type EmailStyleLogoOption = Pick<BrandLogo, "id" | "filename" | "mimeType" | "isPrimary" | "createdAt">;

const DEFAULT_HEADER = "#111111";

/** A logo Outlook can show: PNG or JPEG. */
export function isEmailLogo(logo: Pick<BrandLogo, "filename" | "mimeType">): boolean {
  return (logo.mimeType === "image/png" || logo.mimeType === "image/jpeg") && EMAIL_LOGO_FILENAME.test(logo.filename);
}

/**
 * A header image an email may use: a `header` brand asset, PNG or JPEG, with the pixel size
 * read at upload (whole pixels, within the stored limits). The band's size comes from the row.
 */
export function isEmailHeaderImage<T extends Pick<BrandAsset, "category" | "filename" | "mimeType" | "width" | "height">>(
  row: T,
): row is T & { width: number; height: number } {
  const inRange = (n: unknown, max: number) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max;
  return (
    row.category === "header" &&
    isEmailLogo(row) && // PNG/JPEG and a `<uuid>.png|jpg|jpeg` file, as for logos
    inRange(row.width, EMAIL_HEADER_IMAGE_LIMITS.width) &&
    inRange(row.height, EMAIL_HEADER_IMAGE_LIMITS.height)
  );
}

/**
 * Fill an Email style from Brand. Colours are matched by role, then by name (the guidelines-
 * PDF extract never sets a role), then the first non-neutral colour, searching `palette` then
 * `palettes`. The logo is the primary if it's PNG/JPEG, else the newest PNG/JPEG. The name is
 * left blank so the logo shows alone.
 */
export function styleFromBrandKit(
  kit: BrandKit | null | undefined,
  logos: readonly EmailStyleLogoOption[],
): BrandKitEmailStyle {
  const notes: string[] = [];
  const newestFirst = [...logos].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  // Primary as getPrimaryLogo derives it: the flagged one, else the newest.
  const primary = newestFirst.find((l) => l.isPrimary) ?? newestFirst[0] ?? null;
  const logo = primary && isEmailLogo(primary) ? primary : (newestFirst.find(isEmailLogo) ?? null);
  if (!logo) {
    notes.push(
      primary?.mimeType === "image/webp"
        ? "Your primary logo is WebP, which Outlook can't show — upload a PNG or JPG"
        : "No logos yet — add a PNG or JPG in Brand › Logos",
    );
  }

  const colours = paletteColours(kit);
  const headerColor =
    byRole(colours, "primary") ??
    byName(colours, /primary|brand/i) ??
    colours.find((c) => !isNeutral(c.hex))?.hex ??
    DEFAULT_HEADER;
  const accentColor =
    byRole(colours, "accent") ??
    byRole(colours, "secondary") ??
    byName(colours, /accent|secondary|highlight|cta|button/i) ??
    colours.find((c) => !isNeutral(c.hex) && c.hex !== headerColor)?.hex ??
    headerColor;

  return { logoId: logo?.id ?? null, companyName: null, headerColor, accentColor, notes };
}

type KitColour = { hex: string; name: string; role: string };

function paletteColours(kit: BrandKit | null | undefined): KitColour[] {
  const all = [...(kit?.palette ?? []), ...(kit?.palettes ?? []).flatMap((g) => g.colors)];
  return all.flatMap((c) => {
    const hex = normalizeHex(c.hex);
    return hex ? [{ hex, name: c.name ?? "", role: (c.role ?? "").trim().toLowerCase() }] : [];
  });
}

const byRole = (colours: KitColour[], role: string) => colours.find((c) => c.role === role)?.hex;
const byName = (colours: KitColour[], re: RegExp) => colours.find((c) => re.test(c.name))?.hex;

/** Greys, near-whites and near-blacks: channels within 10% of each other. */
function isNeutral(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!) <= 25;
}
