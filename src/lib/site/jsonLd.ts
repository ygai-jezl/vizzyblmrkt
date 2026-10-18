import { FEATURES, FEATURE_ORDER, FEATURE_TAGS, STAGES, STAGE_IDS, stageOf, type StageId } from "./content";
import { FAQ, GITHUB_URL, LINKEDIN_URL } from "./home";
import { translator } from "./i18n";
import { sitePath, type SiteLang, type SitePage } from "./langs";

/**
 * schema.org JSON-LD for the public site, built from the same words the page shows
 * (so it can only describe what a reader sees). One @graph per page: who we are
 * (Organization, WebSite, SoftwareApplication) plus what the page is.
 */

export type JsonLd = Record<string, unknown>;

export const LOGO_PATH = "/brand/yougrow-logo.png";

export function organization(origin: string): JsonLd {
  return {
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: "YouGrow.ai",
    url: `${origin}/`,
    logo: { "@type": "ImageObject", url: `${origin}${LOGO_PATH}`, width: 512, height: 512 },
    sameAs: [LINKEDIN_URL, GITHUB_URL],
  };
}

function website(origin: string, lang: SiteLang): JsonLd {
  return { "@type": "WebSite", "@id": `${origin}/#website`, url: `${origin}/`, name: "YouGrow.ai", inLanguage: lang, publisher: { "@id": `${origin}/#organization` } };
}

function application(origin: string, lang: SiteLang): JsonLd {
  const { t } = translator(lang);
  return {
    "@type": "SoftwareApplication",
    "@id": `${origin}/#app`,
    name: "YouGrow",
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Marketing automation",
    operatingSystem: "Web",
    url: origin + sitePath(lang, { kind: "home" }),
    publisher: { "@id": `${origin}/#organization` },
    description: t("YouGrow is an agentic marketing platform. Agents plan, create, launch and learn around one shared growth memory."),
    featureList: FEATURE_ORDER.map((f) => t(FEATURES[f].name)),
  };
}

const breadcrumbs = (items: [string, string][]): JsonLd => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })),
});

/** The JSON-LD @graph for a page of the loop site in a language. `withFaq` adds the homepage questions. */
export function siteGraph(origin: string, lang: SiteLang, page: SitePage, opts: { withFaq?: boolean } = {}): JsonLd {
  const { t, fmt, lines } = translator(lang);
  const url = (p: SitePage) => origin + sitePath(lang, p);
  const home = url({ kind: "home" });
  const part = { inLanguage: lang, isPartOf: { "@id": `${origin}/#website` }, about: { "@id": `${origin}/#app` } };
  const graph: JsonLd[] = [organization(origin), website(origin, lang), application(origin, lang)];

  if (page.kind === "stage") {
    const s = STAGES[page.id];
    const u = url(page);
    graph.push(
      { "@type": "WebPage", "@id": u, url: u, name: `${t(s.name)} · ${t("The agentic growth loop")}`, description: `${t(s.promise)} ${t(s.body)}`, ...part },
      breadcrumbs([[t("Home"), home], [t(s.name), u]]),
      {
        "@type": "ItemList",
        name: fmt("Features in {stage}", { stage: t(s.name) }),
        itemListElement: s.features.map((f, i) => ({ "@type": "ListItem", position: i + 1, name: t(FEATURES[f].name), description: t(FEATURE_TAGS[f]), url: url({ kind: "feature", slug: f }) })),
      },
    );
  } else if (page.kind === "feature") {
    const f = FEATURES[page.slug];
    const st: StageId = stageOf(page.slug);
    const u = url(page);
    graph.push(
      { "@type": "WebPage", "@id": u, url: u, name: `${t(f.name)} · YouGrow.ai`, headline: lines(f.h1).join(" "), description: t(f.sub), ...part },
      breadcrumbs([[t("Home"), home], [t(STAGES[st].name), url({ kind: "stage", id: st })], [t(f.name), u]]),
      {
        "@type": "HowTo",
        name: fmt("How {name} works", { name: t(f.name) }),
        description: t(f.sub),
        inLanguage: lang,
        step: f.steps.map((x, i) => ({ "@type": "HowToStep", position: i + 1, name: t(x.title), text: t(x.desc) })),
      },
    );
  } else {
    graph.push(
      { "@type": "WebPage", "@id": home, url: home, name: `YouGrow.ai · ${t("The agentic growth loop")}`, headline: lines("Growth|that|compounds").join(" "), description: t("YouGrow is an agentic marketing platform. Agents plan, create, launch and learn around one shared growth memory."), ...part },
      {
        "@type": "ItemList",
        name: t("The agentic growth loop"),
        itemListOrder: "https://schema.org/ItemListOrderAscending",
        numberOfItems: STAGE_IDS.length,
        itemListElement: STAGE_IDS.map((id, i) => ({ "@type": "ListItem", position: i + 1, name: t(STAGES[id].name), description: t(STAGES[id].promise), url: url({ kind: "stage", id }) })),
      },
    );
    if (opts.withFaq) {
      graph.push({
        "@type": "FAQPage",
        "@id": `${home}#questions`,
        inLanguage: lang,
        mainEntity: FAQ.map((e) => ({ "@type": "Question", name: t(e.q), acceptedAnswer: { "@type": "Answer", text: t(e.a) } })),
      });
    }
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/** Who we are, for pages outside the loop site (developer docs, help, today's homepage). */
export function baseGraph(origin: string): JsonLd {
  return { "@context": "https://schema.org", "@graph": [organization(origin), website(origin, "en"), application(origin, "en")] };
}

/** JSON for a <script type="application/ld+json">: "<" escaped so the text can never close the tag. */
export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

