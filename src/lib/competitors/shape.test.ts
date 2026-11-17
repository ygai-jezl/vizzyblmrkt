import { describe, expect, it } from "vitest";
import { datedByMonth, inSection, languagesOf, newsCandidates, newsPerMonth, samplePaths, sectionOf, sectionTree, statsOf } from "./shape";
import type { BaselinePage } from "./sitemap";

const p = (key: string, lastmod: string | null = null): BaselinePage => ({ key, lastmod });
const NOW = new Date("2026-11-16T12:00:00Z");

describe("sections", () => {
  it("are first segments, a subdomain its own, and lone pages count as top-level pages", () => {
    expect(sectionOf("/news/leeds")).toBe("/news/");
    expect(sectionOf("/news")).toBe("/news/");
    expect(sectionOf("//blog.acme.example/x")).toBe("//blog.acme.example/");
    const pages = [p("/"), p("/about"), p("/contact"), p("/news"), p("/news/a"), p("/news/b"), p("//blog.acme.example/x")];
    expect(sectionTree(pages)).toEqual([
      { path: "/", pages: 3 },
      { path: "/news/", pages: 3 },
      { path: "//blog.acme.example/", pages: 1 },
    ]);
  });

  it("splits a big section into its parts when they tell more", () => {
    const pages = [
      ...Array.from({ length: 150 }, (_, i) => p(`/en/news/${i}`)),
      ...Array.from({ length: 100 }, (_, i) => p(`/en/treatments/${i}`)),
      ...Array.from({ length: 20 }, (_, i) => p(`/about-${i}/x`)),
    ];
    const tree = sectionTree(pages);
    expect(tree[0]).toEqual({ path: "/en/", pages: 250 });
    expect(tree.slice(1, 3)).toEqual([
      { path: "/en/news/", pages: 150 },
      { path: "/en/treatments/", pages: 100 },
    ]);
  });
});

describe("the numbers", () => {
  it("find languages only when there are at least two with a few pages", () => {
    const two = [...Array.from({ length: 6 }, (_, i) => p(`/fr/${i}`)), ...Array.from({ length: 9 }, (_, i) => p(`/de-at/${i}`))];
    expect(languagesOf(two)).toEqual(["de-at", "fr"]);
    expect(languagesOf(Array.from({ length: 9 }, (_, i) => p(`/it/${i}`)))).toEqual([]);
  });

  it("count pages dated in each of the last 12 months", () => {
    const months = datedByMonth([p("/a", "2026-11-02"), p("/b", "2026-11-10"), p("/c", "2026-01-05"), p("/d", "2024-01-01"), p("/e")], NOW);
    expect(months).toHaveLength(12);
    expect(months.at(-1)).toEqual({ month: "2026-11", pages: 2 });
    expect(months[0]).toEqual({ month: "2025-12", pages: 0 });
    expect(months.find((m) => m.month === "2026-01")?.pages).toBe(1);
  });

  it("pick news-like sections, biggest first, in other languages too", () => {
    const tree = [
      { path: "/treatments/", pages: 40 },
      { path: "/actualites/", pages: 12 },
      { path: "/blog/", pages: 30 },
      { path: "//news.acme.example/", pages: 5 },
      { path: "/press/", pages: 2 },
    ];
    expect(newsCandidates(tree).map((c) => c.path)).toEqual(["/blog/", "/actualites/", "//news.acme.example/"]);
  });

  it("say how often the news page posts, from dates over six months", () => {
    const pages = [p("/blog"), ...Array.from({ length: 12 }, (_, i) => p(`/blog/${i}`, `2026-${String(6 + (i % 5)).padStart(2, "0")}-15`))];
    expect(newsPerMonth(pages, "/blog/", NOW)).toBe(2);
    expect(newsPerMonth([p("/blog/a", "2026-11-01")], "/blog/", NOW)).toBeNull();
    expect(inSection("/blog", "/blog/")).toBe(true);
    expect(statsOf(pages, NOW, "/blog/").pages).toBe(13);
  });

  it("sample across sections rather than the first few pages", () => {
    const pages = [...Array.from({ length: 100 }, (_, i) => p(`/blog/${i}`)), ...Array.from({ length: 10 }, (_, i) => p(`/shop/${i}`))];
    const samples = samplePaths(pages, sectionTree(pages), 40);
    expect(samples.get("/blog/")!.length).toBeGreaterThan(samples.get("/shop/")!.length);
    expect(samples.get("/shop/")!.length).toBeGreaterThanOrEqual(3);
    // Spread through the section, not just its first pages.
    expect(samples.get("/blog/")!.some((k) => Number(k.split("/")[2]) >= 50)).toBe(true);
  });
});
