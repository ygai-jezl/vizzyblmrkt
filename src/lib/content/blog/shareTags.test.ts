import { describe, expect, it } from "vitest";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { isHttpsAddress, shareTags, withHeroHtml, withHeroMarkdown } from "./shareTags";
import { suggestBlogSchema } from "./schema";
import { renderArticleHtml } from "./markdown";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";

const URL_ = "https://acme.example/img/hero.png";
const base = { alt: 'A lighthouse "beam"', title: "Pick a CRM", description: "How to choose." };

describe("the hero in what an article hands over", () => {
  it("share tags only with an https address on the client's site, the share card first", () => {
    expect(shareTags({ ...base, imageUrl: "" })).toBeNull();
    expect(shareTags({ ...base, imageUrl: "http://acme.example/x.png" })).toBeNull();
    expect(shareTags({ ...base, imageUrl: "/api/admin/workspace/ws/asset/h.png" })).toBeNull();
    const tags = shareTags({ ...base, imageUrl: URL_, shareImageUrl: "https://acme.example/img/share.png", pageUrl: "https://acme.example/blog/crm" })!;
    expect(tags).toContain('<meta property="og:image" content="https://acme.example/img/share.png">');
    expect(tags).toContain('<meta property="og:image:width" content="1200">');
    expect(tags).toContain('<meta property="og:image:alt" content="A lighthouse &quot;beam&quot;">');
    expect(tags).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(tags).toContain('<meta property="og:url" content="https://acme.example/blog/crm">');
    expect(shareTags({ ...base, imageUrl: URL_ })).toContain('content="1600"');
  });

  it("puts the image under the H1 in the Markdown and the HTML", () => {
    const md = withHeroMarkdown("# Pick a CRM\n\nStart here.", { url: URL_, alt: "A [desk]" });
    expect(md).toBe(`# Pick a CRM\n\n![A desk](${URL_})\n\nStart here.`);
    expect(withHeroMarkdown("No title.", { url: URL_, alt: "x" }).startsWith("![x]")).toBe(true);
    expect(withHeroMarkdown("# T", { url: "ftp://x", alt: "x" })).toBe("# T");
    const html = withHeroHtml(renderArticleHtml("# Pick a CRM\n\nStart here."), { url: URL_, alt: "<b>" });
    expect(html).toMatch(/<\/h1>\n<img src="https:\/\/acme\.example\/img\/hero\.png" alt="&lt;b&gt;" width="1600" height="900">/);
    expect(isHttpsAddress(" https://a.example/x.png ")).toBe(true);
  });

  it("the schema lists the image only at the client's address, never ours", () => {
    const withHero = BlogArticleMetaSchema.parse({ hero: { status: "ready", heroRef: "h.png", shareRef: "s.png" } });
    const none = suggestBlogSchema({ markdown: SAMPLE_ARTICLE, meta: withHero, brief: SAMPLE_BRIEF });
    expect(JSON.stringify(none.jsonLd)).not.toContain('"image"');
    expect(JSON.stringify(none.jsonLd)).not.toContain("h.png");
    expect(none.notes.join(" ")).toContain("give its address under Export");

    const placed = suggestBlogSchema({
      markdown: SAMPLE_ARTICLE,
      meta: { ...withHero, imageUrl: URL_, shareImageUrl: "https://acme.example/img/share.png" },
      brief: SAMPLE_BRIEF,
    });
    const posting = (placed.jsonLd!["@graph"] as Record<string, unknown>[]).find((n) => n["@type"] === "BlogPosting")!;
    expect(posting.image).toEqual([
      { "@type": "ImageObject", url: URL_, width: 1600, height: 900 },
      { "@type": "ImageObject", url: "https://acme.example/img/share.png", width: 1200, height: 630 },
    ]);
  });
});
