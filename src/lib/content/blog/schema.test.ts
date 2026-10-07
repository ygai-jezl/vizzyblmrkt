import { describe, expect, it } from "vitest";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { schemaScriptTag, suggestBlogSchema } from "./schema";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";

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
