import { FEATURE_PATH, type FeatureSlug, type StageId } from "./content";

/** The site's languages: English at the root, the others under /<code>. The same six the product UI ships. */
export const SITE_LANGS = ["en", "es", "fr", "de", "ja", "ar"] as const;
export type SiteLang = (typeof SITE_LANGS)[number];
export type OtherLang = Exclude<SiteLang, "en">;
export const OTHER_LANGS = SITE_LANGS.filter((l): l is OtherLang => l !== "en");

export const LANG_INFO: Record<SiteLang, { name: string; dir: "ltr" | "rtl"; ogLocale: string }> = {
  en: { name: "English", dir: "ltr", ogLocale: "en_GB" },
  es: { name: "Español", dir: "ltr", ogLocale: "es_ES" },
  fr: { name: "Français", dir: "ltr", ogLocale: "fr_FR" },
  de: { name: "Deutsch", dir: "ltr", ogLocale: "de_DE" },
  ja: { name: "日本語", dir: "ltr", ogLocale: "ja_JP" },
  ar: { name: "العربية", dir: "rtl", ogLocale: "ar_AR" },
};

export function isOtherLang(x: string): x is OtherLang {
  return (OTHER_LANGS as readonly string[]).includes(x);
}

export type SitePage =
  | { kind: "home" }
  | { kind: "stage"; id: StageId }
  | { kind: "feature"; slug: FeatureSlug };

/** A page's path in a language: `/`, `/loop/plan`, `/fr/features/brand-kit`. */
export function sitePath(lang: SiteLang, page: SitePage): string {
  const prefix = lang === "en" ? "" : `/${lang}`;
  if (page.kind === "home") return prefix || "/";
  if (page.kind === "stage") return `${prefix}/loop/${page.id}`;
  return `${prefix}/features/${FEATURE_PATH[page.slug]}`;
}

/** hreflang alternates for a page: every language plus x-default (English). */
export function languageAlternates(page: SitePage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of SITE_LANGS) out[l] = sitePath(l, page);
  out["x-default"] = sitePath("en", page);
  return out;
}
