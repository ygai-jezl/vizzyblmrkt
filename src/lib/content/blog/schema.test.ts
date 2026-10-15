import { describe, expect, it } from "vitest";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { schemaScriptTag, suggestBlogSchema } from "./schema";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { organizationJsonLd } from "@/lib/brandMap/orgMarkup";
import { projectArticleMap } from "./articleMap";

type Node = Record<string, unknown>;
const graphOf = (jsonLd: Record<string, unknown> | null) => (jsonLd?.["@graph"] ?? []) as Node[];

describe("suggested schema markup", () => {
  const meta = BlogArticleMetaSchema.parse({ metaDescription: "What AI search visibility monitoring is and how to choose a tool." });
  const full = suggestBlogSchema({
    markdown: SAMPLE_ARTICLE,
    meta,
    brief: SAMPLE_BRIEF,
    pageUrl: "https://acme.example/blog/visibility",
    logoUrl: "https://acme.example/logo.png",
  });

  it("mirrors what is on the page: headline, date, FAQ and citations", () => {
    const [organization, posting, faq] = graphOf(full.jsonLd);
    expect(full.jsonLd?.["@context"]).toBe("https://schema.org");
    // The publisher is one entry the article points at.
    expect(organization).toEqual({
      "@type": "Organization",
      "@id": "https://acme.example/#organization",
      name: "Acme",
      url: "https://acme.example",
      logo: "https://acme.example/logo.png",
    });
    expect(posting).toMatchObject({
      "@type": "BlogPosting",
      "@id": "https://acme.example/blog/visibility#article",
      headline: "What is AI search visibility monitoring?",
      description: meta.metaDescription,
      datePublished: "2026-10-07",
      dateModified: "2026-10-07",
      isPartOf: { "@type": "WebPage", "@id": "https://acme.example/blog/visibility" },
      mainEntityOfPage: { "@type": "WebPage", "@id": "https://acme.example/blog/visibility" },
      author: { "@id": "https://acme.example/#organization" },
      publisher: { "@id": "https://acme.example/#organization" },
    });
    expect(faq).toMatchObject({ "@id": "https://acme.example/blog/visibility#faq" });
    expect(faq).toMatchObject({ "@type": "FAQPage" });
    const questions = (faq!.mainEntity as Node[]).map((q) => q.name);
    expect(questions).toEqual(["Is it accurate?", "Who is it for?", "Can the data be exported?"]);
    // Only third-party pages are citations, each once, named by its title in the Sources list.
    expect(posting!.citation).toEqual([
      { "@type": "CreativeWork", url: "https://research.example.org/buyers-2026", name: "How buyers research software" },
      { "@type": "CreativeWork", url: "https://press.example.net/ai-search-converts", name: "AI search converts" },
    ]);
  });

  it("marks up an entity only when the article names it", () => {
    const [, posting] = graphOf(full.jsonLd);
    expect(posting!.about).toEqual([
      { "@type": "Thing", name: "Acme Visibility" },
      { "@type": "Thing", name: "AI search visibility monitoring" },
    ]);
    // Rivalco is named in the copy; ExampleChat is in the brief but never in the article.
    expect(posting!.mentions).toEqual([{ "@type": "Thing", name: "Rivalco" }]);
  });

  it("follows the article when it changes, and uses a named author", () => {
    const edited = SAMPLE_ARTICLE.replace("### Is it accurate?", "### How accurate is it?").replace(/## Sources[\s\S]*$/, "");
    const s = suggestBlogSchema({ markdown: edited, brief: { ...SAMPLE_BRIEF, author: "Sam Example" } });
    const [, posting, faq] = graphOf(s.jsonLd);
    expect((faq!.mainEntity as Node[])[0]!.name).toBe("How accurate is it?");
    expect(posting!.author).toEqual({ "@type": "Person", name: "Sam Example" });
    // Without the meta description the opening answer stands in.
    expect(String(posting!.description)).toContain("AI search visibility monitoring is the practice");
  });

  it("says what only the host can fill in, and never invents it", () => {
    const s = suggestBlogSchema({ markdown: SAMPLE_ARTICLE, brandName: "Weekly Plate" });
    // No site to identify the publisher by: it stays inside the article, with no made-up id.
    const [posting] = graphOf(s.jsonLd);
    expect(posting).not.toHaveProperty("mainEntityOfPage");
    expect(posting!.publisher).toEqual({ "@type": "Organization", name: "Weekly Plate" });
    expect(full.notes.join(" ")).toContain("sameAs");
    expect(s.notes.join(" ")).toContain("the page's URL (set the hub URL), the publisher's site, a logo");
    expect(full.notes.join(" ")).not.toContain("Still to fill in");
    expect(suggestBlogSchema({ markdown: "No title here." })).toEqual({
      jsonLd: null,
      notes: ["Give the article a title (one # H1) and the markup can be suggested."],
    });
  });

  it("can't be broken out of by text in the article", () => {
    const s = suggestBlogSchema({ markdown: "# A </script><script>alert(1)</script> title\n\n*Last updated: 2026-10-07*\n\nAnswer." });
    const tag = schemaScriptTag(s.jsonLd!);
    expect(tag.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(tag.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, ""))["@graph"][0].headline).toContain(
      "</script>",
    );
  });
});

describe("suggested markup with a brand map", () => {
  const map = projectArticleMap({
    ...BrandMapDecidedSchema.parse({
      identity: {
        name: "Acme",
        category: "AI search visibility monitoring",
        site: "https://acme.example",
        profiles: [{ url: "https://www.linkedin.com/company/acme-example", source: "site", confirmedAt: "t" }],
        categorySameAs: [{ url: "https://www.wikidata.org/wiki/Q1001", source: "wikidata", confirmedAt: "t" }],
      },
      names: [
        { id: "n_aaaaaaaa", name: "Acme Visibility", kind: "product", home: "https://acme.example/product", sameAs: [] },
        { id: "n_bbbbbbbb", name: "Rivalco", kind: "alternative", home: "https://acme.example/vs/rivalco", sameAs: [{ url: "https://www.wikidata.org/wiki/Q1002", source: "wikidata", confirmedAt: "t" }] },
      ],
    }),
    rev: 1,
  });
  const graph = (s: ReturnType<typeof suggestBlogSchema>) => (s.jsonLd!["@graph"] as Array<Record<string, unknown>>);
  const posting = (s: ReturnType<typeof suggestBlogSchema>) => graph(s).find((g) => g["@type"] === "BlogPosting")!;

  it("puts the brand's confirmed profiles on the publisher, and identifiers on the names the article uses", () => {
    const s = suggestBlogSchema({ markdown: SAMPLE_ARTICLE, brief: SAMPLE_BRIEF, pageUrl: "https://acme.example/blog/visibility", map });
    expect(graph(s).find((g) => g["@type"] === "Organization")).toMatchObject({ sameAs: ["https://www.linkedin.com/company/acme-example"] });
    expect(posting(s).about).toEqual([
      { "@type": "Thing", name: "Acme Visibility", url: "https://acme.example/product" },
      { "@type": "Thing", name: "AI search visibility monitoring", sameAs: ["https://www.wikidata.org/wiki/Q1001"] },
    ]);
    // An alternative carries its identifier, never the brand's own comparison page as its url.
    expect(posting(s).mentions).toContainEqual({ "@type": "Thing", name: "Rivalco", sameAs: ["https://www.wikidata.org/wiki/Q1002"] });
    expect(s.notes.join(" ")).toContain("lists your confirmed profile links from your brand map as sameAs");
  });

  it("gives the brand's publisher the map's site, so its @id is the home page markup's", () => {
    const www = { ...SAMPLE_BRIEF, publisherUrl: "https://www.acme.example/" };
    const s = suggestBlogSchema({ markdown: SAMPLE_ARTICLE, brief: www, pageUrl: "https://acme.example/blog/visibility", map });
    expect(graph(s).find((g) => g["@type"] === "Organization")).toMatchObject({ "@id": "https://acme.example/#organization", url: "https://acme.example" });
  });

  it("never puts the brand's profiles on someone else's site", () => {
    const guest = { ...SAMPLE_BRIEF, publisherUrl: "https://partner.example", publisherName: "Partner" };
    const s = suggestBlogSchema({ markdown: SAMPLE_ARTICLE, brief: guest, pageUrl: "https://partner.example/blog/x", map });
    expect(graph(s).find((g) => g["@type"] === "Organization")).not.toHaveProperty("sameAs");
  });

  it("is exactly as before without a map", () => {
    const input = { markdown: SAMPLE_ARTICLE, brief: SAMPLE_BRIEF, pageUrl: "https://acme.example/blog/visibility" };
    expect(suggestBlogSchema({ ...input, map: null })).toEqual(suggestBlogSchema(input));
  });

  it("builds the home page's Organization markup from the saved map", () => {
    expect(organizationJsonLd(BrandMapDecidedSchema.parse({ identity: { name: "Acme", site: "https://acme.example/", statement: "We measure AI answers.", profiles: [{ url: "https://x.com/acme_example" }] } }))).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": "https://acme.example/#organization",
      name: "Acme",
      url: "https://acme.example",
      description: "We measure AI answers.",
      sameAs: ["https://x.com/acme_example"],
    });
    expect(organizationJsonLd(BrandMapDecidedSchema.parse({ identity: { name: "Acme" } }))).toBeNull();
  });
});
