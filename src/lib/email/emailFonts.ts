import { EMAIL_FONT_IDS, type EmailFontId } from "@/lib/types/tenant";
import type { ResolvedEmailStyle } from "./emailStyle";

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
