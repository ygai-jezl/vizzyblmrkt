import { describe, expect, it } from "vitest";
import { chunkLines, keyUrl, line, pageKey, pagesFromChunks, parseSitemap } from "./sitemap";

const SITE = "acme-dental.example";
const WEB = "https://www.acme-dental.example";

describe("reading a sitemap", () => {
  it("reads a urlset's pages and days, and an index's sitemaps", () => {
    const urlset = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://www.acme-dental.example/</loc><lastmod>2026-11-02T10:00:00+00:00</lastmod></url>
      <url><loc>https://www.acme-dental.example/treatments/implants</loc></url>
    </urlset>`;
    expect(parseSitemap(urlset)).toEqual({
      kind: "urlset",
      entries: [
        { loc: "https://www.acme-dental.example/", lastmod: "2026-11-02" },
        { loc: "https://www.acme-dental.example/treatments/implants", lastmod: null },
      ],
    });
    const index = `<sitemapindex><sitemap><loc>https://www.acme-dental.example/post-sitemap.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(index)).toEqual({ kind: "index", entries: [{ loc: "https://www.acme-dental.example/post-sitemap.xml", lastmod: null }] });
  });

  it("decodes entities and CDATA, and never takes an image's address for the page's", () => {
    const xml = `<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url>
      <image:image><image:loc>https://cdn.example/x.png</image:loc></image:image>
      <loc><![CDATA[https://www.acme-dental.example/a?x=1&amp;y=2]]></loc>
    </url></urlset>`;
    expect(parseSitemap(xml).entries).toEqual([{ loc: "https://www.acme-dental.example/a?x=1&y=2", lastmod: null }]);
  });

  it("reads a text sitemap, and nothing from a page that isn't one", () => {
    expect(parseSitemap("https://a.example/one\nhttps://a.example/two\n").entries.map((e) => e.loc)).toEqual(["https://a.example/one", "https://a.example/two"]);
    expect(parseSitemap("<!doctype html><html><body>Not found</body></html>")).toEqual({ kind: "unknown", entries: [] });
  });
});

describe("a page's key", () => {
  it("is its path on the competitor's own host, without tracking or a trailing slash", () => {
    expect(pageKey("https://acme-dental.example/news/?utm_source=x", WEB, SITE)).toBe("/news");
    expect(pageKey("https://www.acme-dental.example/", WEB, SITE)).toBe("/");
    expect(pageKey("https://www.acme-dental.example/find?city=leeds", WEB, SITE)).toBe("/find?city=leeds");
  });

  it("keeps another host of the same site apart, and drops pages off the site", () => {
    expect(pageKey("https://blog.acme-dental.example/post-1", WEB, SITE)).toBe("//blog.acme-dental.example/post-1");
    expect(pageKey("https://elsewhere.example/news", WEB, SITE)).toBeNull();
    expect(pageKey("mailto:hi@acme-dental.example", WEB, SITE)).toBeNull();
    expect(keyUrl("//blog.acme-dental.example/post-1", WEB)).toBe("https://blog.acme-dental.example/post-1");
    expect(keyUrl("/news", WEB)).toBe("https://www.acme-dental.example/news");
  });

  it("is cut to 500 characters", () => {
    expect(pageKey(`https://acme-dental.example/${"a".repeat(900)}`, WEB, SITE)!.length).toBe(500);
  });
});

describe("chunks", () => {
  it("split by bytes, keep lines whole, and read back each page once", () => {
    const lines = Array.from({ length: 50 }, (_, i) => line(`/p/${i}`, i % 2 ? "2026-10-01" : null));
    const chunks = chunkLines(lines, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(200);
    const back = pagesFromChunks([...chunks.map((lines, n) => ({ n, lines })), { n: 99, lines: line("/p/1", "2020-01-01") }]);
    expect(back).toHaveLength(50);
    expect(back.find((p) => p.key === "/p/1")?.lastmod).toBe("2026-10-01");
    expect(back.find((p) => p.key === "/p/0")?.lastmod).toBeNull();
  });
});
