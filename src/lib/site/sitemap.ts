import { DOC_PAGES } from "@/lib/developers/docs";
import { isDevelopersDocsEnabled } from "@/lib/developers/flags";
import { HELP_PAGES } from "@/lib/help/pages";
import { isHelpPagesEnabled } from "@/lib/help/flags";
import { FEATURE_ORDER, STAGE_IDS } from "./content";
import { isSiteLanguagesEnabled, isSiteLoopEnabled } from "./flags";
import { SITE_LANGS, languageAlternates, sitePath, type SitePage } from "./langs";

/** One address in the sitemap, with its language versions (hreflang) when it has them. */
export interface SitemapEntry {
  loc: string;
  alternates?: Record<string, string>;
}

/** The loop site's pages: home, the six stages, the eleven features. */
export function loopPages(): SitePage[] {
  return [
    { kind: "home" },
    ...STAGE_IDS.map((id): SitePage => ({ kind: "stage", id })),
    ...FEATURE_ORDER.map((slug): SitePage => ({ kind: "feature", slug })),
  ];
}

/** Every public page that is switched on in this environment. */
export function sitemapEntries(origin: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  if (isSiteLoopEnabled()) {
    const langs = isSiteLanguagesEnabled() ? SITE_LANGS : (["en"] as const);
    for (const page of loopPages()) {
      const alternates = isSiteLanguagesEnabled()
        ? Object.fromEntries(Object.entries(languageAlternates(page)).map(([l, p]) => [l, origin + p]))
        : undefined;
      for (const lang of langs) out.push({ loc: origin + sitePath(lang, page), alternates });
    }
  } else {
    out.push({ loc: `${origin}/` });
  }
  if (isDevelopersDocsEnabled()) for (const p of DOC_PAGES) out.push({ loc: origin + p.path });
  if (isHelpPagesEnabled()) for (const p of HELP_PAGES) out.push({ loc: origin + p.path });
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((e) => {
    const alts = Object.entries(e.alternates ?? {}).map(
      ([lang, href]) => `\n    <xhtml:link rel="alternate" hreflang="${esc(lang)}" href="${esc(href)}"/>`,
    );
    return `  <url>\n    <loc>${esc(e.loc)}</loc>${alts.join("")}\n  </url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
