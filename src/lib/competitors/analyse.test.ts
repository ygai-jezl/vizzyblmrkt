import { describe, expect, it, vi } from "vitest";
import { NO_METER } from "@/lib/agents/gemini";
import { labelSite, plainPostsHeadline, plainSiteHeadline, readFoundLines, searchForSite, summarisePosts, summariseSiteChange, tidy } from "./analyse";
import { diffBaselines } from "./diff";
import { sectionTree } from "./shape";
import type { BaselinePage } from "./sitemap";

const SITE = "acme-dental.example";
const pages: BaselinePage[] = [
  { key: "/", lastmod: null },
  { key: "/news/implants", lastmod: "2026-11-01" },
  { key: "/news/leeds", lastmod: "2026-11-05" },
  { key: "/news/hours", lastmod: "2026-10-01" },
  { key: "/treatments/implants", lastmod: null },
  { key: "/treatments/whitening", lastmod: null },
  { key: "/pricing", lastmod: null },
];
const sections = sectionTree(pages);

describe("finding a sitemap with search", () => {
  it("keeps only addresses on the competitor's own site", () => {
    expect(readFoundLines("SITEMAP: https://www.acme-dental.example/sitemap_index.xml\nNEWS: https://medium.example/acme", SITE)).toEqual({
      sitemap: "https://www.acme-dental.example/sitemap_index.xml",
      news: null,
    });
    expect(readFoundLines("SITEMAP: NONE\nNEWS: http://acme-dental.example/news).", SITE)).toEqual({ sitemap: null, news: "https://acme-dental.example/news" });
  });

  it("asks the grounded model with the site in the prompt, and returns null when there's no model", async () => {
    const grounded = vi.fn(async () => ({ text: "SITEMAP: https://acme-dental.example/sitemap.xml\nNEWS: NONE" }));
    expect(await searchForSite({ name: "Acme Dental", website: "https://acme-dental.example", site: SITE }, 10_000, NO_METER, { grounded })).toEqual({
      sitemap: "https://acme-dental.example/sitemap.xml",
      news: null,
    });
    expect((grounded.mock.calls[0] as unknown as [string])[0]).toContain("acme-dental.example");
    expect(await searchForSite({ name: "Acme Dental", website: "https://acme-dental.example", site: SITE }, 10_000, NO_METER, { grounded: async () => null })).toBeNull();
  });
});

describe("words for a site's shape", () => {
  it("keeps only what is tied to a path we read, and never a number from the model", async () => {
    const generate = vi.fn(async () =>
      JSON.stringify({
        summary: "A clinic group that puts most of its effort into treatments — and news.",
        sections: [
          { path: "/news/", label: "News", purpose: "Clinic news" },
          { path: "/made-up/", label: "Invented", purpose: "Nope" },
        ],
        themes: [
          { name: "Implants", paths: ["/news/implants", "/treatments/implants", "/nowhere"] },
          { name: "Ghost", paths: ["/nowhere"] },
        ],
        notable: [
          { label: "Prices", path: "/pricing", why: "They show prices openly" },
          { label: "Fake", path: "/fake", why: "x" },
        ],
        worthKnowing: ["They publish about twice a month.", "We leverage synergies."],
        newsPath: "/news/",
      }),
    );
    const out = await labelSite({ name: "Acme Dental", website: "https://acme-dental.example", pages, sections, candidates: [{ path: "/news/", pages: 3 }] }, 10_000, { generate });
    expect(out?.newsSection).toBe("/news/");
    expect(out?.analysis.summary).toBe("A clinic group that puts most of its effort into treatments, and news.");
    expect(out?.analysis.sections.find((s) => s.path === "/news/")).toEqual({ path: "/news/", pages: 3, label: "News", purpose: "Clinic news" });
    expect(out?.analysis.sections.some((s) => s.path === "/made-up/")).toBe(false);
    expect(out?.analysis.themes).toEqual([{ name: "Implants", paths: ["/news/implants", "/treatments/implants"] }]);
    expect(out?.analysis.notable.map((n) => n.path)).toEqual(["/pricing"]);
    // A sentence with an AI tell is dropped rather than shown.
    expect(out?.analysis.worthKnowing).toEqual(["They publish about twice a month."]);
    // The paths go to the model inside the untrusted fence.
    expect((generate.mock.calls[0] as unknown as [string])[0]).toMatch(/<site_text>[\s\S]*\/news\/implants[\s\S]*<\/site_text>/);
  });

  it("is null when the model has nothing usable", async () => {
    expect(await labelSite({ name: "A", website: "https://a.example", pages, sections, candidates: [] }, 10_000, { generate: async () => null })).toBeNull();
    expect(await labelSite({ name: "A", website: "https://a.example", pages, sections, candidates: [] }, 10_000, { generate: async () => "not json" })).toBeNull();
  });
});

describe("words for what changed", () => {
  it("fall back to words written by code without a model, or with too little time", async () => {
    const posts = [{ title: "Same day implants explained", description: "", url: "https://acme-dental.example/news/implants" }];
    expect(plainPostsHeadline(posts)).toBe('1 new post: "Same day implants explained"');
    expect(await summarisePosts({ name: "Acme", posts }, 10_000, { generate: async () => null })).toEqual({ headline: '1 new post: "Same day implants explained"', summary: "", topics: [] });
    const generate = vi.fn();
    await summarisePosts({ name: "Acme", posts }, 2000, { generate });
    expect(generate).not.toHaveBeenCalled();

    const diff = diffBaselines([{ key: "/a", lastmod: null }], [{ key: "/a", lastmod: null }, { key: "/locations/leeds", lastmod: null }], { whole: true });
    expect(plainSiteHeadline(diff)).toBe("1 page added (most under /locations/)");
    expect((await summariseSiteChange({ name: "Acme", website: "https://a.example", before: 1, after: 2, diff }, 10_000, { generate: async () => null })).headline).toBe(
      "1 page added (most under /locations/)",
    );
  });

  it("use the model's words when it gives them, tidied to house style", async () => {
    const generate = async () => JSON.stringify({ headline: "3 new posts — implants, hours and Leeds", summary: "They are opening in Leeds.", topics: ["Implants", "Leeds"] });
    const words = await summarisePosts({ name: "Acme", posts: [{ title: "x", description: "", url: "https://a.example/x" }] }, 10_000, { generate });
    expect(words).toEqual({ headline: "3 new posts, implants, hours and Leeds", summary: "They are opening in Leeds.", topics: ["Implants", "Leeds"] });
    expect(tidy("a - b – c", 100)).toBe("a, b, c");
  });
});
