import type { Metadata } from "next";
import { FEATURES, FEATURE_TAGS, STAGES } from "./content";
import { isSiteLanguagesEnabled, siteMetadataBase } from "./flags";
import { translator } from "./i18n";
import { LANG_INFO, SITE_LANGS, languageAlternates, sitePath, type SiteLang, type SitePage } from "./langs";

/** The share image for every page of the site (1200 x 630). */
export const OG_IMAGE = { url: "/og/yougrow-loop.png", width: 1200, height: 630 };

/** Default title and description for any page that sets none. */
export const DEFAULT_DESCRIPTION =
  "YouGrow is an agentic marketing platform. Agents plan, create, launch and learn around one shared growth memory, and you approve what ships.";

/** A page's title and description, in its language. */
export function pageText(lang: SiteLang, page: SitePage): { title: string; description: string } {
  const { t } = translator(lang);
  if (page.kind === "stage") {
    const s = STAGES[page.id];
    return { title: `${t(s.name)} · ${t("The agentic growth loop")} · YouGrow.ai`, description: `${t(s.promise)} ${t(s.body)}` };
  }
  if (page.kind === "feature") {
    const f = FEATURES[page.slug];
    return { title: `${t(f.name)} · ${t(FEATURE_TAGS[page.slug])} · YouGrow.ai`, description: t(f.sub) };
  }
  return {
    title: `YouGrow.ai · ${t("The agentic growth loop")}`,
    description: t("YouGrow is an agentic marketing platform. Agents plan, create, launch and learn around one shared growth memory."),
  };
}

/** Title, description, canonical address, hreflang alternates and share card for a page of the site. */
export function siteMetadata(lang: SiteLang, page: SitePage): Metadata {
  const { title, description } = pageText(lang, page);
  const path = sitePath(lang, page);
  const langs = isSiteLanguagesEnabled();
  return {
    metadataBase: siteMetadataBase(),
    title: { absolute: title },
    description,
    alternates: { canonical: path, ...(langs ? { languages: languageAlternates(page) } : {}) },
    openGraph: {
      type: "website",
      url: path,
      siteName: "YouGrow.ai",
      title,
      description,
      locale: LANG_INFO[lang].ogLocale,
      ...(langs ? { alternateLocale: SITE_LANGS.filter((l) => l !== lang).map((l) => LANG_INFO[l].ogLocale) } : {}),
      images: [{ ...OG_IMAGE, alt: translator(lang).t("The agentic growth loop") }],
    },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE.url] },
  };
}
