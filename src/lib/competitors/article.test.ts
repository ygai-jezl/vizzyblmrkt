import { describe, expect, it } from "vitest";
import { ARTICLE_TEXT_MAX, readArticlePage } from "./article";

const NOW = new Date("2026-11-17T12:00:00Z");
const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");

const LD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "BlogPosting", "@id": "#post", headline: "How a team tripled sign ups", datePublished: "2026-11-02T09:00:00Z", dateModified: "2026-11-10", author: { "@id": "#ana" } },
    { "@type": "Person", "@id": "#ana", name: "Ana Example", url: "https://rival.test/authors/ana" },
    { "@type": "Organization", name: "Rival" },
  ],
});

const POST = `<!doctype html><html><head>
<title>How a team tripled sign ups | Rival</title>
<meta name="description" content="A case study.">
<script type="application/ld+json">${LD}</script>
</head><body>
<header><nav><a href="/pricing">Pricing</a><a href="/blog">Blog</a></nav></header>
<main>
  <article>
    <h1>How a team tripled sign ups</h1>
    <p>By <a href="/authors/ana">Ana Example</a></p>
    <h2>The challenge</h2>
    <p>Sign ups were flat at 2% for a year, says <a href="https://research.example.org/report">a 2025 survey</a>. ${words(80)}</p>
    <script>window.track("x")</script>
    <h3>What they did</h3>
    <ul><li>Wrote for buyers</li><li>Linked to <a href="https://www.rival.test/features/forms">our forms</a></li></ul>
    <p>${words(80)} <a href="/demo" class="btn">Book a demo</a> <a href="#top">Back to top</a> <a href="mailto:hi@rival.test">Email</a></p>
    <nav><a href="/blog/page-2">Next page</a></nav>
    <div class="related-posts"><a href="/blog/other-post">Another post</a></div>
  </article>
  <article><a href="/blog/card">A short card</a></article>
</main>
<footer><a href="/legal">Legal</a></footer>
</body></html>`;

describe("readArticlePage", () => {
  const page = readArticlePage(POST, "https://rival.test/blog/tripled", "rival.test", NOW);

  it("reads the longest <article> and marks every link by number", () => {
    expect(page.region).toBe("article");
    expect(page.links.map((l) => [l.n, l.url, l.anchor])).toEqual([
      [1, "https://rival.test/authors/ana", "Ana Example"],
      [2, "https://research.example.org/report", "a 2025 survey"],
      [3, "https://www.rival.test/features/forms", "our forms"],
      [4, "https://rival.test/demo", "Book a demo"],
      [5, "https://rival.test/blog/other-post", "Another post"],
    ]);
    expect(page.text).toContain("a 2025 survey [L2]");
    expect(page.text).toContain("Book a demo [L4]");
  });

  it("knows its own site's links, and links that sit beside the argument", () => {
    expect(page.links.map((l) => l.internal)).toEqual([true, false, true, true, true]);
    expect(page.links.find((l) => l.n === 5)?.inAside).toBe(true);
    expect(page.links.find((l) => l.n === 4)?.inAside).toBe(false);
  });

  it("leaves out menus, scripts, anchors on the page and mail links", () => {
    expect(page.text).not.toContain("track(");
    expect(page.text).not.toContain("Next page");
    expect(page.text).not.toContain("Pricing");
    expect(page.links.some((l) => /mailto|#top|page-2|legal/.test(l.url))).toBe(false);
  });

  it("keeps headings and counts words without the link marks", () => {
    expect(page.headings).toEqual(["The challenge", "What they did"]);
    expect(page.text).toContain("## The challenge");
    expect(page.text).toContain("- Wrote for buyers");
    expect(page.words).toBeGreaterThan(160);
    expect(page.words).toBeLessThan(220);
  });

  it("reads who wrote it and when from the page's own markup", () => {
    expect(page.title).toBe("How a team tripled sign ups | Rival");
    expect(page.description).toBe("A case study.");
    expect(page.trust).toEqual({
      author: "Ana Example",
      authorUrl: "https://rival.test/authors/ana",
      publishedAt: "2026-11-02",
      updatedAt: "2026-11-10",
      schemaTypes: ["BlogPosting", "Person", "Organization"],
    });
  });

  it("falls back to <main>, then to the body without its header, menus and footer", () => {
    const main = readArticlePage(`<html><body><nav><a href="/x">Menu</a></nav><main><p>${words(20)}</p><a href="/y">Y</a></main></body></html>`, "https://rival.test/p", "rival.test", NOW);
    expect(main.region).toBe("main");
    expect(main.links.map((l) => l.url)).toEqual(["https://rival.test/y"]);
    const body = readArticlePage(
      `<html><body><header><a href="/h">Home</a></header><div><p>${words(20)}</p></div><footer><a href="/f">F</a></footer></body></html>`,
      "https://rival.test/p",
      "rival.test",
      NOW,
    );
    expect(body.region).toBe("body");
    expect(body.links).toEqual([]);
    expect(body.words).toBe(20);
  });

  it("takes the author from a meta tag and the date from article:published_time when there is no JSON-LD", () => {
    const p = readArticlePage(
      `<html><head><meta name="author" content="Sam Example"><meta property="article:published_time" content="2026-10-01T10:00:00Z"><meta property="article:modified_time" content="2026-10-05"></head><body><article><p>${words(200)}</p></article></body></html>`,
      "https://rival.test/p",
      "rival.test",
      NOW,
    );
    expect(p.trust).toMatchObject({ author: "Sam Example", authorUrl: null, publishedAt: "2026-10-01", updatedAt: "2026-10-05", schemaTypes: [] });
  });

  it("caps the text a model reads", () => {
    const p = readArticlePage(`<html><body><article><p>${words(20_000, "longword")}</p></article></body></html>`, "https://rival.test/p", "rival.test", NOW);
    expect(p.text.length).toBe(ARTICLE_TEXT_MAX);
  });

  it("never throws on a page it can't make sense of", () => {
    const p = readArticlePage("not html at all <<<", "https://rival.test/p", "rival.test", NOW);
    expect(p.links).toEqual([]);
    expect(p.trust.schemaTypes).toEqual([]);
  });
});
