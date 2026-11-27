import { sanitizeFontFamily } from "@/lib/content/fonts";
import type { DeckTheme } from "@/lib/raise/docs/theme";

/** Only this app's own font proxy, with nothing in the path that could leave a CSS string. */
const FONT_URL = /^\/api\/brand-font\/[A-Za-z0-9%._-]+\/[A-Za-z0-9%._-]+$/;

/**
 * The @font-face rules for the brand fonts a deck uses, uploaded on Brand (served by
 * /api/brand-font). Family names go through sanitizeFontFamily and links must be the font proxy's,
 * since the rules are written into a style element. A family picked from Google Fonts and not
 * uploaded falls back to its stack: the admin never loads Google's CSS. Pure.
 */
export function deckFontCss(faces: DeckTheme["fontFaces"]): string {
  return faces
    .map((f) => ({ family: sanitizeFontFamily(f.family), url: f.url }))
    .filter((f) => f.family && FONT_URL.test(f.url))
    .map((f) => `@font-face{font-family:'${f.family}';src:url('${f.url}');font-display:swap;}`)
    .join("\n");
}

export function DeckFonts({ theme }: { theme: DeckTheme }) {
  const css = deckFontCss(theme.fontFaces);
  return css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null;
}
