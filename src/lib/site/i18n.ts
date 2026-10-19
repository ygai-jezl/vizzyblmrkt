import es from "./i18n/es.json";
import fr from "./i18n/fr.json";
import de from "./i18n/de.json";
import ja from "./i18n/ja.json";
import ar from "./i18n/ar.json";
import type { OtherLang, SiteLang } from "./langs";

/**
 * Site translations. English strings are the keys (gettext style), so English
 * needs no file and a missing translation falls back to English. A "|" in a key
 * splits a headline into lines; the translation keeps the same number of parts
 * (the hero "Growth|that|compounds" and the "GROWTH|MEMORY" core label may differ).
 * `{name}` placeholders are kept as they are. Server-only: client components get
 * translated strings as props, so the dictionaries never ship to the browser.
 */
export const DICTS: Record<OtherLang, Record<string, string>> = { es, fr, de, ja, ar };

export interface Translator {
  lang: SiteLang;
  t: (s: string) => string;
  fmt: (s: string, vars: Record<string, string | number>) => string;
  /** A "|"-split headline, translated, as its lines. */
  lines: (parts: readonly string[] | string) => string[];
}

export function translator(lang: SiteLang): Translator {
  const dict = lang === "en" ? null : DICTS[lang];
  const t = (s: string) => (dict && dict[s]) || s;
  return {
    lang,
    t,
    fmt: (s, vars) => t(s).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)),
    lines: (parts) => t(typeof parts === "string" ? parts : parts.join("|")).split("|"),
  };
}
