import { EMAIL_FONT_IDS, type EmailFontId } from "@/lib/types/tenant";
import type { ResolvedEmailStyle } from "./emailStyle";
import { isEmailThemePreset } from "./emailThemes";

/**
 * Email fonts — the table a theme picks its heading and body fonts from. Pure + client-safe
 * (no env, no server imports): shared by the resolver, the renderers and the Email style page.
 *
 * Every inline `font-family` lists only a font's SAFE stack: fonts installed on Windows and Mac,
 * ending in a generic family. Outlook for Windows falls back to Times New Roman when the first
 * font listed isn't installed, so a web font is never written inline; it's loaded only by the
 * inboxes that read a `<head>` @font-face block (Apple Mail, Outlook for Mac and a few others),
 * and everyone else sees its safe stack. Android has no Georgia, Verdana or Trebuchet, so phones
 * there show their own serif or sans.
 *
 * Uploaded Brand fonts stay out of email: licences rarely cover it, and ttf/otf files work poorly.
 */

/** Today's font on every email: what an email with no theme uses, byte for byte. */
export const FONT = "system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

const SANS_FALLBACK = "'Segoe UI',Helvetica,Arial,sans-serif";
/** The fonts SANS_FALLBACK shows as, by name: Arial is only there for the rare inbox with neither. */
const SANS_NAME = "Segoe UI or Helvetica";
const GEORGIA = "Georgia,'Times New Roman',Times,serif";

export interface EmailFont {
  id: EmailFontId;
  label: string;
  /** What every inline font-family lists: installed fonts, ending in a generic family. */
  safeStack: string;
  /**
   * A web font: its @font-face family (its files are named by the id, 400 and 700 only), and the
   * safe font most inboxes show instead, by name: the first fonts of its safe stack (Windows has
   * Segoe UI, a Mac or iPhone Helvetica). Absent = a safe font, the same in every inbox.
   */
  web?: { family: string; fallback: "Segoe UI or Helvetica" | "Georgia" };
}

export const EMAIL_FONTS: Readonly<Record<EmailFontId, EmailFont>> = {
  system: { id: "system", label: "System", safeStack: FONT },
  arial: { id: "arial", label: "Arial", safeStack: "Arial,Helvetica,sans-serif" },
  georgia: { id: "georgia", label: "Georgia", safeStack: GEORGIA },
  verdana: { id: "verdana", label: "Verdana", safeStack: "Verdana,Geneva,sans-serif" },
  trebuchet: { id: "trebuchet", label: "Trebuchet MS", safeStack: "'Trebuchet MS',Helvetica,Arial,sans-serif" },
  inter: { id: "inter", label: "Inter", safeStack: SANS_FALLBACK, web: { family: "Inter", fallback: SANS_NAME } },
  poppins: { id: "poppins", label: "Poppins", safeStack: SANS_FALLBACK, web: { family: "Poppins", fallback: SANS_NAME } },
  nunito: { id: "nunito", label: "Nunito", safeStack: SANS_FALLBACK, web: { family: "Nunito", fallback: SANS_NAME } },
  montserrat: {
    id: "montserrat",
    label: "Montserrat",
    safeStack: SANS_FALLBACK,
    web: { family: "Montserrat", fallback: SANS_NAME },
  },
  lora: { id: "lora", label: "Lora", safeStack: GEORGIA, web: { family: "Lora", fallback: "Georgia" } },
  "playfair-display": {
    id: "playfair-display",
    label: "Playfair Display",
    safeStack: GEORGIA,
    web: { family: "Playfair Display", fallback: "Georgia" },
  },
};

/** The fonts in the order the page lists them: safe ones first, then web fonts. */
export const EMAIL_FONT_LIST: readonly EmailFont[] = EMAIL_FONT_IDS.map((id) => EMAIL_FONTS[id]);

export function isEmailFontId(id: unknown): id is EmailFontId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(EMAIL_FONTS, id);
}

export function isWebFont(id: EmailFontId): boolean {
  return !!EMAIL_FONTS[id].web;
}

/** The inline font-family for body text or headings: today's FONT with no theme, else the theme font's safe stack. */
export function fontFor(style: Pick<ResolvedEmailStyle, "theme"> | null | undefined, role: "body" | "heading"): string {
  const theme = style?.theme;
  if (!theme) return FONT;
  const id = role === "heading" ? theme.headingFont : theme.bodyFont;
  return isEmailFontId(id) ? EMAIL_FONTS[id].safeStack : FONT;
}

// ── Web fonts (EMAIL_WEB_FONTS_ENABLED) ──────────────────────────────────────

/**
 * The web font files, vendored in public/email-fonts/ with each family's OFL licence: the Latin
 * subset of each family at 400 and 700, as woff2 and woff (from Fontsource 5.3.0), named
 * `{id}-{weight}.{version}.{woff2|woff}`. They're served with a year's immutable cache
 * (next.config.ts), so a changed file gets a new version, never the same name. Nothing is
 * loaded from Google, and a fork needs nothing but its own origin.
 */
export const EMAIL_FONT_FILE_VERSION = "v1";
export const EMAIL_FONT_WEIGHTS = [400, 700] as const;
export type EmailFontWeight = (typeof EMAIL_FONT_WEIGHTS)[number];

/** Marks the `<head>` block, so a send can tell its HTML carries one (sendEmail's inline_css). */
export const WEB_FONTS_MARKER = "data-vzb-fonts";

/** The classes the block's rules target: the card, and the header band's name and alt text. */
export const WEB_FONT_CLASSES = { card: "vzb-card", heading: "vzb-h" } as const;

/** What the files hold (Fontsource's Latin subset): other scripts use the safe stack and download nothing. */
const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

/** An https origin as the resolver writes it (URL.origin): nothing in it can break out of url(…). */
const FONT_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/**
 * One font file's URL. It's the same for every recipient and carries no query string, so
 * loading a font can't track an open.
 */
export function emailFontFileUrl(origin: string, id: EmailFontId, weight: EmailFontWeight, format: "woff2" | "woff"): string {
  return `${origin}/email-fonts/${id}-${weight}.${EMAIL_FONT_FILE_VERSION}.${format}`;
}

type ThemeFonts = Pick<ResolvedEmailStyle, "theme"> | null | undefined;

/**
 * The web fonts an email loads (heading font first, each once) and where from; null when it
 * loads none: no theme (or none the shell draws), no web font in it, or no usable origin.
 * Null = no head block and no classes, so the email is exactly what it is with web fonts off.
 */
function webFontsOf(style: ThemeFonts): { origin: string; heading: EmailFont; body: EmailFont; web: EmailFont[] } | null {
  const theme = style?.theme;
  const origin = theme?.webFontOrigin;
  if (!theme || !isEmailThemePreset(theme.preset) || !origin || !FONT_ORIGIN_RE.test(origin)) return null;
  if (!isEmailFontId(theme.headingFont) || !isEmailFontId(theme.bodyFont)) return null;
  const heading = EMAIL_FONTS[theme.headingFont];
  const body = EMAIL_FONTS[theme.bodyFont];
  const web = [heading, body].filter((f, i, all) => f.web && all.indexOf(f) === i);
  return web.length ? { origin, heading, body, web } : null;
}

/** Whether an email with this style carries the web font block (and the classes it targets). */
export function hasWebFonts(style: ThemeFonts): boolean {
  return webFontsOf(style) !== null;
}

/** A font as the block's rules name it: the web family first when it's one, then its safe stack. */
function cssStack(font: EmailFont): string {
  return font.web ? `'${font.web.family}',${font.safeStack}` : font.safeStack;
}

/**
 * The `<head>` block that loads a theme's web fonts, or "" when it has none (see webFontsOf).
 *  - `<!--[if !mso]>` hides it from Outlook for Windows, which would otherwise pick up a font it
 *    doesn't have and show Times New Roman. Every inline font-family is a safe stack anyway.
 *  - @font-face for each web family at 400 and 700, Latin only (`unicode-range`).
 *  - The rules sit in `@media screen{}`, which CSS inliners keep in the head, and put the web
 *    family first on the card's text (the body font) and its headings and the band's name (the
 *    heading font). An inbox that drops the block, or doesn't load fonts, keeps the inline
 *    safe stacks: Gmail, Outlook.com and Yahoo show those.
 */
export function webFontHead(style: ThemeFonts): string {
  const w = webFontsOf(style);
  if (!w) return "";
  const faces = w.web.flatMap((font) =>
    EMAIL_FONT_WEIGHTS.map(
      (weight) =>
        `@font-face{font-family:'${font.web!.family}';font-style:normal;font-weight:${weight};` +
        `src:url(${emailFontFileUrl(w.origin, font.id, weight, "woff2")}) format('woff2'),` +
        `url(${emailFontFileUrl(w.origin, font.id, weight, "woff")}) format('woff');unicode-range:${LATIN_RANGE}}`,
    ),
  );
  const card = `.${WEB_FONT_CLASSES.card}`;
  const bodySel = [card, ...["td", "p", "div", "a", "span", "li"].map((t) => `${card} ${t}`)].join(",");
  // A link or span in a heading matches the body rule itself, so it's named here too, more specifically.
  const headingSel = [
    ...["h1", "h2", "h3"].flatMap((h) => [`${card} ${h}`, `${card} ${h} a`, `${card} ${h} span`]),
    `.${WEB_FONT_CLASSES.heading}`,
  ].join(",");
  const rules =
    `@media screen{${bodySel}{font-family:${cssStack(w.body)}!important}` +
    `${headingSel}{font-family:${cssStack(w.heading)}!important}}`;
  return `<!--[if !mso]><!--><style ${WEB_FONTS_MARKER}>\n${faces.join("\n")}\n${rules}\n</style><!--<![endif]-->`;
}

/** Whether a finished email's HTML carries the web font block. */
export function carriesWebFonts(html: string): boolean {
  return html.includes(`<style ${WEB_FONTS_MARKER}>`);
}
