import { describe, expect, it } from "vitest";
import { dayFromText, feedLinkFromHtml, isPostOf, listingCards, listingLinks, parseFeed } from "./feed";

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

describe("the date on a post's card", () => {
  const NOW = new Date("2026-11-18T12:00:00Z");

  it("reads a day, a month by name and a year in either order, or a plain ISO day", () => {
    expect(dayFromText("18 Nov, 2026 / Research", NOW)).toBe("2026-11-18");
    expect(dayFromText("Posted 13th November 2026", NOW)).toBe("2026-11-13");
    expect(dayFromText("Nov 3, 2026", NOW)).toBe("2026-11-03");
    expect(dayFromText("September 9th 2026", NOW)).toBe("2026-09-09");
    expect(dayFromText("9 Sept 2026", NOW)).toBe("2026-09-09");
    expect(dayFromText("Updated 2026-10-01T09:00", NOW)).toBe("2026-10-01");
    expect(dayFromText("May 4, 2026: why we may switch", NOW)).toBe("2026-05-04");
  });

  it("takes the first date when there are two", () => {
    expect(dayFromText("12 Nov, 2026 · first published 1 Jan 2025", NOW)).toBe("2026-11-12");
  });

  it("reads nothing from an all number date, an impossible one, one in the future, or none", () => {
    expect(dayFromText("11/12/2026", NOW)).toBeNull();
    expect(dayFromText("31 Feb 2026", NOW)).toBeNull();
    expect(dayFromText("1 Dec 2026", NOW)).toBeNull();
    expect(dayFromText("Black Friday in AI Search 2026", NOW)).toBeNull();
    expect(dayFromText("", NOW)).toBeNull();
  });
});

describe("cards on a listing page", () => {
  const NOW = new Date("2026-11-18T12:00:00Z");

  it("dates each post from its own card, in page order, with the page's own links left out", () => {
    const html = `
      <nav><a href="/news/">All</a><a href="/news/insights">Insights</a></nav>
      <a href="/news/b2b-buyers"><img alt=""><p>18 Nov, 2026 / Research</p><h3>The B2B buyer journey</h3></a>
      <a href="/news/black-friday"><p>13 Nov, 2026 / Research</p><h3>Black Friday in AI Search 2026</h3></a>
      <a href="/news/black-friday">Read more</a>`;
    expect(listingCards(html, NEWS, NEWS, SITE, NOW)).toEqual([
      { url: "https://www.acme-dental.example/news/insights", publishedAt: null, rank: 0 },
      { url: "https://www.acme-dental.example/news/b2b-buyers", publishedAt: "2026-11-18", rank: 1 },
      { url: "https://www.acme-dental.example/news/black-friday", publishedAt: "2026-11-13", rank: 2 },
    ]);
  });

  it("finds a date beside the link in the same card, never in the card next to it", () => {
    const html = `
      <ul>
        <li><article><time datetime="2026-11-10">10 November</time><h2><a href="/news/one">One</a></h2><a href="/tag/x">tag</a></article></li>
        <li><article><h2><a href="/news/two">Two</a></h2></article></li>
        <li><article><span>Oct 2, 2026</span><h2><a href="/news/three">Three</a></h2></article></li>
      </ul>`;
    expect(listingCards(html, NEWS, NEWS, SITE, NOW).map((c) => [c.url.split("/").pop(), c.publishedAt])).toEqual([
      ["one", "2026-11-10"],
      ["two", null],
      ["three", "2026-10-02"],
    ]);
  });

  it("keeps the order of a page that shows no dates", () => {
    const html = `<a href="/news/c">C</a><a href="/news/a">A</a><a href="/news/b">B</a>`;
    expect(listingCards(html, NEWS, NEWS, SITE, NOW).map((c) => [c.url.split("/").pop(), c.rank, c.publishedAt])).toEqual([
      ["c", 0, null],
      ["a", 1, null],
      ["b", 2, null],
    ]);
  });

  it("finds the same posts as the links on the page", () => {
    const html = `<a href="/news/a">A</a><a href="https://elsewhere.example/news/x">X</a><a href="/news/a#top">A again</a><a href="/about">About</a><a href="/news/b">B</a>`;
    expect(listingCards(html, NEWS, NEWS, SITE, NOW).map((c) => c.url)).toEqual(listingLinks(html, NEWS, NEWS, SITE));
  });
});
