/**
 * A site folder per language (PAGE_LANGUAGES_ENABLED): where an article's version in that language
 * lives on the brand's own site. Pure, and safe in the browser.
 */

/** A folder ends with "/", so a slug joins it cleanly. */
export function asFolder(url: string): string {
  const u = url.trim();
  return u.endsWith("/") ? u : `${u}/`;
}

/**
 * The folders to keep: only languages still in the list and not the default, with an address,
 * each ending in "/". A language taken off the list loses its folder.
 */
export function cleanSiteAddresses(input: Record<string, string> | null | undefined, list: readonly string[], defaultLocale: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, url] of Object.entries(input ?? {})) {
    if (lang === defaultLocale || !list.includes(lang) || !url.trim()) continue;
    out[lang] = asFolder(url);
  }
  return out;
}

export function sameAddresses(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** A version's suggested address: its language's folder and the article's slug. Null without a folder or a slug. */
export function versionAddressOf(folder: string | null | undefined, slug: string | null | undefined): string | null {
  const s = (slug ?? "").trim().replace(/^\/+|\/+$/g, "");
  return folder && s ? `${asFolder(folder)}${s}` : null;
}
