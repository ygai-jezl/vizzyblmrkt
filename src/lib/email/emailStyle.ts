import {
  EMAIL_LOGO_FILENAME,
  EMAIL_STYLE_LIMITS,
  HIDDEN_NAME_CHARS,
  type BrandKit,
  type EmailStyleInput,
} from "@/lib/types/tenant";
import type { BrandLogo } from "@/lib/types/brandLogo";
import { normalizeHex } from "@/lib/content/create/colorPalette";

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
}

/**
 * Map a saved (or, on the page, unsaved) style to what the renderers draw. The caller
 * supplies the logo URL — the server resolver checks it's this tenant's; the page builds
 * a preview one — and the name to fall back on (the footer's sender brand).
 *
 * The header options are only read with `headerOptions` (the caller's flag), and only a
 * real one is set: no gradient, a gradient equal to the header colour and Auto text leave
 * the keys out, so the result is exactly what it was without them.
 */
export function resolveStoredStyle(
  stored:
    | Pick<
        EmailStyleInput,
        "logo" | "companyName" | "headerColor" | "accentColor" | "headerGradientColor" | "headerText"
      >
    | null
    | undefined,
  opts: {
    logoUrlFor: (logo: { id: string; filename: string }) => string | null;
    fallbackName: string;
    headerOptions?: boolean;
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
  };
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

// ── Logo URLs ────────────────────────────────────────────────────────────────

const LOGO_PATH = /^\/api\/brand-logo\/([^/]+)\/([^/]+)$/;

/** https, our public logo route, a PNG/JPEG file, and nothing else (no query, hash or credentials). */
function parseLogoUrl(url: string): { href: string; tenantSegment: string } | null {
  if (typeof url !== "string" || /[?#\s\\]/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  const m = LOGO_PATH.exec(u.pathname);
  if (!m || !EMAIL_LOGO_FILENAME.test(m[2]!)) return null;
  return { href: u.href, tenantSegment: m[1]! };
}

/** The tenant-agnostic check — what the shell can repeat in the browser for previews. */
export function isLogoUrlShape(url: string): boolean {
  return parseLogoUrl(url) !== null;
}

/** The full check, run once by the server resolver: the logo must be THIS tenant's. */
export function safeLogoUrl(url: string, tenantId: string): string | null {
  const parsed = parseLogoUrl(url);
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
