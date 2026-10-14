import type { BlogArticleMeta, BlogBrief } from "@/lib/types/contentPlan";
import { EMPTY_BLOG_BRIEF, hostOf, normalizeUrl, ownHosts } from "./brief";
import { outlineArticle } from "./outline";
import type { ArticleMap } from "./articleMap";
import { mentionsName } from "./names";
import { fold } from "@/lib/brandMap/changes";

/**
 * Suggested schema markup for a blog article — JSON-LD the site that hosts the article
 * can paste in. The markup is BUILT FROM THE ARTICLE, never written by a model, so it
 * can only ever describe what a reader sees: the headline is the H1, the date is the
 * "Last updated" line, each FAQ entry is a question and answer on the page, each
 * citation is a link in the copy, and an entity is only marked up when the article names
 * it. Edit the article and the markup follows. Pure + client-safe.
 *
 * We do not host the article, so this is a suggestion plus the short list of things only
 * the host can do (where to put it, what to fill in, how to check it).
 */

export interface BlogSchemaInput {
  markdown: string;
  meta?: BlogArticleMeta | null;
  brief?: BlogBrief | null;
  /** The article's own URL, when the operator has given one. */
  pageUrl?: string | null;
  /** Fallback publisher name when the brief has none (the programme's name). */
  brandName?: string | null;
  /** Absolute URL of the brand's logo, when there is one. */
  logoUrl?: string | null;
  /** The brand map the article is written from: its confirmed profile links and identifiers
   *  become `sameAs`. Without one, the markup is exactly as before. */
  map?: ArticleMap | null;
}

export interface BlogSchemaSuggestion {
  /** One JSON-LD document (an @graph), or null when the article has no title to mark up. */
  jsonLd: Record<string, unknown> | null;
  /** What the host should know or do, most important first. */
  notes: string[];
}

const HEADLINE_MAX = 110;

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function isHttps(u: string | null | undefined): u is string {
  return typeof u === "string" && /^https:\/\/[^\s<>"']+$/i.test(u);
}

export function suggestBlogSchema(input: BlogSchemaInput): BlogSchemaSuggestion {
  const brief = input.brief ?? EMPTY_BLOG_BRIEF;
  const o = outlineArticle(input.markdown);
  if (!o.title) {
    return { jsonLd: null, notes: ["Give the article a title (one # H1) and the markup can be suggested."] };
  }

  const pageUrl = isHttps(input.pageUrl) ? input.pageUrl : null;
  const publisherName = brief.publisherName.trim() || (input.brandName ?? "").trim();
  const publisherUrl = isHttps(brief.publisherUrl) ? brief.publisherUrl : null;
  const logoUrl = isHttps(input.logoUrl) ? input.logoUrl : null;
  const author = brief.author.trim();
  const description = (input.meta?.metaDescription ?? "").trim() || clip(o.bluf, 160);
  const lower = o.plain.toLowerCase();

  // The publisher is its own entry in the graph when it has a site to be identified by,
  // so the article (and anything else on the site) can point at one Organization.
  const orgId = publisherUrl ? `${publisherUrl.replace(/\/+$/, "")}/#organization` : null;
  // The brand map's confirmed profile links go on the publisher only when the publisher IS
  // the brand (its site is the map's): an article placed on someone else's site never puts
  // the brand's profiles on its host.
  const map = input.map ?? null;
  const mapSite = map?.identity.site ? hostOf(map.identity.site) : "";
  const orgSameAs = map && mapSite && publisherUrl && hostOf(publisherUrl) === mapSite ? map.identity.profiles : [];
  const organization: Record<string, unknown> | null = publisherName
    ? {
        "@type": "Organization",
        ...(orgId ? { "@id": orgId } : {}),
        name: publisherName,
        ...(publisherUrl ? { url: publisherUrl } : {}),
        ...(logoUrl ? { logo: logoUrl } : {}),
        ...(orgSameAs.length ? { sameAs: [...orgSameAs] } : {}),
      }
    : null;
  const publisherRef = organization ? (orgId ? { "@id": orgId } : organization) : null;

  // Only what the article actually names: the subject goes in `about`, the rest in `mentions`.
  const visible = brief.entities.filter((e) => lower.includes(e.name.toLowerCase()));
  // With a brand map, a name the article uses carries its confirmed identifiers, and the
  // brand's own product its page — only when the article writes the name out whole.
  const decorate = (e: (typeof visible)[number]): Record<string, unknown> => {
    if (!map || !mentionsName(o.plain, e.name)) return {};
    if (e.relation === "category") {
      return fold(e.name) === fold(map.identity.category) && map.identity.categorySameAs.length ? { sameAs: [...map.identity.categorySameAs] } : {};
    }
    const n = map.names.find((x) => fold(x.name) === fold(e.name) || x.aliases.some((a) => fold(a) === fold(e.name)));
    if (!n) return {};
    return {
      ...(n.kind === "product" && n.home ? { url: n.home } : {}),
      ...(n.sameAs.length ? { sameAs: [...n.sameAs] } : {}),
    };
  };
  const thing = (e: (typeof visible)[number]) => ({ "@type": "Thing", name: e.name, ...decorate(e) });
  const about = visible.filter((e) => e.relation === "product" || e.relation === "category").map(thing);
  const mentions = visible.filter((e) => e.relation === "alternative" || e.relation === "integration").map(thing);

  // Each third-party page the copy links to, once. A page is linked as a short citation
  // in the body and by its title in the Sources list — the title (the longer text) names it.
  const own = ownHosts(brief, [pageUrl]);
  const cited = new Map<string, string>();
  for (const l of o.links) {
    const url = normalizeUrl(l.href);
    if (!url || own.has(hostOf(url))) continue;
    if ((cited.get(url)?.length ?? -1) < l.text.length) cited.set(url, l.text);
  }
  const citation = [...cited].map(([url, name]) => ({ "@type": "CreativeWork", url, ...(name ? { name } : {}) }));

  const webPage = pageUrl ? { "@type": "WebPage", "@id": pageUrl } : null;
  const posting: Record<string, unknown> = {
    "@type": "BlogPosting",
    ...(webPage ? { "@id": `${pageUrl}#article`, isPartOf: webPage, mainEntityOfPage: webPage } : {}),
    headline: clip(o.title, HEADLINE_MAX),
    ...(description ? { description } : {}),
    ...(o.lastUpdated ? { datePublished: o.lastUpdated, dateModified: o.lastUpdated } : {}),
    ...(author ? { author: { "@type": "Person", name: author } } : publisherRef ? { author: publisherRef } : {}),
    ...(publisherRef ? { publisher: publisherRef } : {}),
    wordCount: o.words,
    ...(about.length ? { about } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(citation.length ? { citation } : {}),
  };

  // An Organization the article points at by @id sits in the graph beside it.
  const graph: Record<string, unknown>[] = [...(organization && orgId ? [organization] : []), posting];
  if (o.faq.length) {
    graph.push({
      "@type": "FAQPage",
      ...(pageUrl ? { "@id": `${pageUrl}#faq` } : {}),
      mainEntity: o.faq.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    });
  }

  const missing: string[] = [];
  if (!pageUrl) missing.push("the page's URL (set the hub URL)");
  if (!publisherName) missing.push("the publisher's name");
  if (!publisherUrl) missing.push("the publisher's site");
  if (!logoUrl) missing.push("a logo");
  if (!o.lastUpdated) missing.push("the “Last updated” date");

  const notes: string[] = [
    `Paste it into the page's <head> as one <script type="application/ld+json"> block (or give it to your CMS's SEO field). It describes this article: the headline, ${
      o.lastUpdated ? "the Last updated date" : "no date yet"
    }${o.faq.length ? ` and the ${o.faq.length} FAQ question${o.faq.length === 1 ? "" : "s"}` : ""}.`,
    "It mirrors what is on the page. If you change the title, the date or an FAQ answer after pasting, copy the markup again — never mark up what a reader cannot see.",
  ];
  if (missing.length) notes.push(`Still to fill in before it is complete: ${missing.join(", ")}.`);
  notes.push(
    "datePublished is set to the Last updated date. Once the page is live, keep datePublished at the day it first went up and change only dateModified.",
  );
  if (!o.faq.length) notes.push("The article answers no question outright (no FAQ), so no FAQPage markup is suggested.");
  if (organization) {
    notes.push(
      orgSameAs.length
        ? "The Organization entry names the publisher and lists your confirmed profile links from your brand map as sameAs. Keep Product markup for your product pages."
        : map
          ? "The Organization entry names the publisher. Add your profile links on Brand › Brand map and they are listed here as sameAs. Keep Product markup for your product pages."
          : "The Organization entry names the publisher. Add your profile pages to it as sameAs (LinkedIn, X, Wikidata) — only you know them — and keep Product markup for your product pages.",
    );
  }
  notes.push("Check the page with a structured-data validator (for example Google's Rich Results Test) before you publish.");

  return { jsonLd: { "@context": "https://schema.org", "@graph": graph }, notes };
}

/** The markup as the script block a page carries. `<` is escaped so text from the
 *  article can never close the script element. */
export function schemaScriptTag(jsonLd: Record<string, unknown>): string {
  const json = JSON.stringify(jsonLd, null, 2).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}
