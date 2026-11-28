/**
 * Google's language tags for an article and its versions (PAGE_LANGUAGES_ENABLED): each version's
 * page lists itself and every other version, plus an x-default for everyone else (the default
 * language's page), and its canonical points at itself. Pure, and safe in the browser.
 */

export interface TaggedVersion {
  /** A base code, like "fr". */
  lang: string;
  url: string;
}

/** The hreflang code Google reads: the base code, with Chinese's script (we write Simplified). */
export function hreflangOf(lang: string): string {
  return lang === "zh" ? "zh-Hans" : lang;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The alternate links, the same on every version: every version, then x-default. */
export function alternateLinks(base: TaggedVersion, versions: readonly TaggedVersion[]): string[] {
  const all = [base, ...versions.filter((v) => v.lang !== base.lang)];
  return [
    ...all.map((v) => `<link rel="alternate" hreflang="${hreflangOf(v.lang)}" href="${escapeAttr(v.url)}">`),
    `<link rel="alternate" hreflang="x-default" href="${escapeAttr(base.url)}">`,
  ];
}

/** What goes into one version's <head>: its own canonical, then the alternate links. */
export function languageTagsFor(self: TaggedVersion, base: TaggedVersion, versions: readonly TaggedVersion[]): string {
  return [`<link rel="canonical" href="${escapeAttr(self.url)}">`, ...alternateLinks(base, versions)].join("\n");
}
