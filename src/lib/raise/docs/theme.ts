import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { listLogos } from "@/lib/admin/brandLogos";
import { listBrandFonts } from "@/lib/admin/brandFonts";
import { brandFontPublicUrl, brandLogoPublicUrl } from "@/lib/content/brandKit";
import { fontStackFor, sanitizeFontFamily } from "@/lib/content/fonts";
import { inkOn, luminance, rgb } from "@/lib/content/imageStyle/render/templates/shared";
import type { BrandFont } from "@/lib/types/brandFont";
import type { BrandLogo } from "@/lib/types/brandLogo";
import type { BrandKit, BrandTypography, Tenant } from "@/lib/types/tenant";
import { MAX_WORDS } from "./layouts";

/**
 * The one starter look: white slides in the brand's accent colour, its fonts and its primary logo,
 * read from Brand on each page load (tokens only, no stored CSS, like the email themes). More
 * looks come in a later slice.
 */

export interface DeckTheme {
  ground: "#FFFFFF";
  surface: "#F5F5F3";
  ink: "#141414";
  muted: "#5C5C5C";
  /** The brand's own colour, as it is. */
  accent: string;
  /** The accent darkened until it reads on white (at least 3 to 1), for text and lines. */
  accentText: string;
  /** Text on an accent fill. */
  accentInk: string;
  /** Chart lines, first the accent. */
  chart: string[];
  headingFont: string;
  bodyFont: string;
  /** The brand's uploaded fonts the deck uses, for @font-face rules. */
  fontFaces: Array<{ family: string; url: string }>;
  logoUrl: string | null;
  /** Shown in the heading font where there is no logo. */
  brandName: string;
  maxWords: typeof MAX_WORDS;
}

export const DEFAULT_ACCENT = "#2F5BEA";
const INK = "#141414";
const HEX = /^#[0-9a-fA-F]{6}$/;

const toHex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
const mixHex = (a: string, b: string, t: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
};
/** Contrast against white, as WCAG works it out. */
export const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);

/** The accent moved toward ink, a step at a time, until it is at least 3 to 1 on white. */
export function readableOnWhite(accent: string): string {
  let c = accent.toUpperCase();
  for (let t = 0.1; contrastOnWhite(c) < 3 && t <= 1.0001; t += 0.1) c = mixHex(accent, INK, Math.min(1, t));
  return c;
}

function accentOf(kit: BrandKit | null | undefined): string {
  const palette = (kit?.palette ?? []).filter((c) => HEX.test(c.hex ?? ""));
  const byRole = (role: string) => palette.find((c) => (c.role ?? "").toLowerCase() === role);
  return (byRole("primary") ?? byRole("accent") ?? palette[0])?.hex.toUpperCase() ?? DEFAULT_ACCENT;
}

function familyFor(typography: BrandTypography | null | undefined, roles: string[]): string | null {
  for (const role of roles) {
    const f = (typography?.styles ?? []).find((s) => s.role === role && s.fontFamily?.trim())?.fontFamily;
    if (f) return sanitizeFontFamily(f) || null;
  }
  return null;
}

export interface ThemeInput {
  tenantId: string;
  brandName?: string | null;
  brandKit?: BrandKit | null;
  brandTypography?: BrandTypography | null;
  logo?: Pick<BrandLogo, "filename"> | null;
  fonts?: Array<Pick<BrandFont, "family" | "filename">>;
}

/** The look from the brand kit. Pure. */
export function deckThemeFor(input: ThemeInput): DeckTheme {
  const accent = accentOf(input.brandKit);
  const accentText = readableOnWhite(accent);
  const kitFonts = (input.brandKit?.fonts ?? []).map((f) => sanitizeFontFamily(f)).filter(Boolean);
  const heading = familyFor(input.brandTypography, ["title", "heading"]) ?? kitFonts[0] ?? "Inter";
  const body = familyFor(input.brandTypography, ["body"]) ?? kitFonts[1] ?? kitFonts[0] ?? "Inter";
  const used = new Set([heading, body].map((f) => f.toLowerCase()));
  const fontFaces = (input.fonts ?? [])
    .map((f) => ({ family: sanitizeFontFamily(f.family), url: brandFontPublicUrl(input.tenantId, f.filename) }))
    .filter((f) => f.family && used.has(f.family.toLowerCase()));
  return {
    ground: "#FFFFFF",
    surface: "#F5F5F3",
    ink: "#141414",
    muted: "#5C5C5C",
    accent,
    accentText,
    accentInk: inkOn(accent),
    chart: [accentText, "#5C5C5C", "#A3A3A3"],
    headingFont: fontStackFor(heading),
    bodyFont: fontStackFor(body),
    fontFaces,
    logoUrl: input.logo ? brandLogoPublicUrl(input.tenantId, input.logo.filename) : null,
    brandName: (input.brandName ?? "").trim().slice(0, 80),
    maxWords: MAX_WORDS,
  };
}

export interface ThemeDeps {
  loadTenant?: (id: string) => Promise<Tenant | null>;
  logos?: (ctx: TenantContext) => Promise<BrandLogo[]>;
  fonts?: (ctx: TenantContext) => Promise<BrandFont[]>;
}

/** The look for this brand: the tenant's kit and typography, its primary logo and uploaded fonts. Every read fails soft. */
export async function loadDeckTheme(ctx: TenantContext, deps: ThemeDeps = {}): Promise<DeckTheme> {
  const [tenant, logos, fonts] = await Promise.all([
    (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null),
    (deps.logos ?? listLogos)(ctx).catch(() => [] as BrandLogo[]),
    (deps.fonts ?? listBrandFonts)(ctx).catch(() => [] as BrandFont[]),
  ]);
  // The flagged primary, else the newest, as Brand picks it (getPrimaryLogo).
  const logo = logos.find((l) => l.isPrimary) ?? logos[0] ?? null;
  return deckThemeFor({ tenantId: ctx.tenantId, brandName: tenant?.tenantName, brandKit: tenant?.brandKit, brandTypography: tenant?.brandTypography, logo, fonts });
}
