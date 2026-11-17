import { describe, expect, it } from "vitest";
import { feedLinkFromHtml, isPostOf, listingLinks, parseFeed } from "./feed";

const SITE = "acme-dental.example";
const NEWS = "https://www.acme-dental.example/news/";

describe("a news page's feed", () => {
  it("is found in the page's head, on the same site only", () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" title="News" href="/news/feed/"></head>`;
    expect(feedLinkFromHtml(html, NEWS, SITE)).toBe("https://www.acme-dental.example/news/feed/");
    const away = `<link rel="alternate" type="application/atom+xml" href="https://feeds.elsewhere.example/acme">`;
    expect(feedLinkFromHtml(away, NEWS, SITE)).toBeNull();
  });

  it("reads RSS items with their links, titles and days", () => {
    const rss = `<rss><channel><title>News</title>
      <item><title><![CDATA[Same day implants explained]]></title><link>https://www.acme-dental.example/news/same-day-implants</link><pubDate>Thu, 12 Nov 2026 09:00:00 GMT</pubDate></item>
      <item><title>Opening hours &amp; holidays</title><link>/news/opening-hours</link></item>
    </channel></rss>`;
    expect(parseFeed(rss, NEWS)).toEqual([
      { url: "https://www.acme-dental.example/news/same-day-implants", title: "Same day implants explained", publishedAt: "2026-11-12" },
      { url: "https://www.acme-dental.example/news/opening-hours", title: "Opening hours & holidays", publishedAt: null },
    ]);
  });

  it("reads Atom entries by their alternate link", () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A new clinic in Leeds</title>
      <link rel="edit" href="https://www.acme-dental.example/wp/edit/9"/><link rel="alternate" href="https://www.acme-dental.example/news/leeds"/>
      <published>2026-11-10T08:00:00Z</published></entry></feed>`;
    expect(parseFeed(atom, NEWS)).toEqual([{ url: "https://www.acme-dental.example/news/leeds", title: "A new clinic in Leeds", publishedAt: "2026-11-10" }]);
  });
});

describe("posts on a listing page", () => {
  it("are the links under the news page, each once, never a list page or the page itself", () => {
    const html = `
      <a href="/news/">News</a>
      <a href="/news/same-day-implants">Implants</a>
      <a href="/news/same-day-implants#top">Implants again</a>
      <a href="/news/page/2">Older</a>
      <a href="/news/tag/implants">Tag</a>
      <a href="/treatments/implants">A treatment</a>
      <a href="https://elsewhere.example/news/x">Away</a>
      <a href="/news/leeds-clinic?utm_source=home">Leeds</a>`;
    expect(listingLinks(html, NEWS, NEWS, SITE)).toEqual([
      "https://www.acme-dental.example/news/same-day-implants",
      "https://www.acme-dental.example/news/leeds-clinic",
    ]);
  });

  it("at the top of a site, counts pages one or two levels down", () => {
    expect(isPostOf("https://acme-dental.example/my-first-post", "https://acme-dental.example/", SITE)).toBe(true);
    expect(isPostOf("https://acme-dental.example/a/b/c", "https://acme-dental.example/", SITE)).toBe(false);
  });

  it("doesn't count a date archive as a post, but does count a post under a date", () => {
    for (const archive of ["/news/2026", "/news/2026/11", "/news/2026/11/13", "/news/2026/11/13/"]) {
      expect(isPostOf(`https://www.acme-dental.example${archive}`, NEWS, SITE), archive).toBe(false);
    }
    expect(isPostOf("https://www.acme-dental.example/news/2026/11/13/leeds-clinic", NEWS, SITE)).toBe(true);
    expect(isPostOf("https://www.acme-dental.example/news/1234", NEWS, SITE)).toBe(true);
  });
});
