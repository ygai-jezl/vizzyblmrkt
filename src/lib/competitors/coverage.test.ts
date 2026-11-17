import { describe, expect, it } from "vitest";
import type { CompetitorArticle } from "@/lib/types/competitor";
import { coverageFrom, flagOf, type OurSubject } from "./coverage";
import { articleViewOf, detailOf } from "./view";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const art = (competitorId: string, subjectIds: string[], over: Partial<CompetitorArticle> = {}): CompetitorArticle =>
  ({
    id: `${competitorId}_${Math.random().toString(36).slice(2)}`,
    competitorId,
    status: "read",
    publishedAt: "2026-11-01",
    readAt: "2026-11-17T00:00:00.000Z",
    subjectIds,
    newTopic: null,
    asks: [],
    links: [],
    stats: [],
    sources: [],
    reader: { roles: [], companies: "", pains: [] },
    mentions: { you: [], others: [], products: [] },
    trust: { author: null, authorUrl: null, publishedAt: null, updatedAt: null, schemaTypes: [] },
    ...over,
  }) as CompetitorArticle;

const competitors = [
  { id: "cmp_a", name: "Rival" },
  { id: "cmp_b", name: "Shopkeep" },
];
const subjects = new Map<string, OurSubject>([
  ["sub_forms", { name: "Forms", you: 0 }],
  ["sub_ads", { name: "Ads", you: 1 }],
  ["sub_seo", { name: "SEO", you: 4 }],
  ["sub_open", { name: "Pricing pages", you: 0 }],
]);

describe("flagOf", () => {
  it("says what a row means for what to write next", () => {
    expect(flagOf(0, 0, 0)).toBe("open");
    expect(flagOf(0, 2, 0)).toBe("you_lead");
    expect(flagOf(3, 0, 1)).toBe("gap");
    expect(flagOf(6, 1, 2)).toBe("crowded");
    expect(flagOf(6, 1, 1)).toBe("even");
    expect(flagOf(2, 4, 2)).toBe("you_lead");
  });
});

describe("coverageFrom", () => {
  const articles = [
    art("cmp_a", ["sub_forms"]),
    art("cmp_a", ["sub_forms"]),
    art("cmp_b", ["sub_forms", "sub_ads"]),
    art("cmp_a", ["sub_ads"]),
    art("cmp_b", ["sub_ads"]),
    art("cmp_a", ["sub_seo"]),
    art("cmp_a", ["sub_gone"]),
    art("cmp_a", [], { newTopic: "Shop apps" }),
    art("cmp_b", [], { newTopic: "shop apps" }),
    art("cmp_a", ["sub_forms"], { publishedAt: "2026-07-01" }),
    art("cmp_gone", ["sub_forms"]),
    art("cmp_a", ["sub_forms"], { status: "queued" }),
  ];

  it("counts the last 90 days by subject and competitor, and flags each row", () => {
    const v = coverageFrom(articles, competitors, subjects, { nowMs: NOW, allSubjects: true });
    expect(v.articles).toBe(9);
    expect(v.rows.map((r) => [r.name, r.byCompetitor, r.they, r.you, r.flag])).toEqual([
      ["Forms", { cmp_a: 2, cmp_b: 1 }, 3, 0, "gap"],
      ["Ads", { cmp_b: 2, cmp_a: 1 }, 3, 1, "crowded"],
      ["SEO", { cmp_a: 1 }, 1, 4, "you_lead"],
      ["Pricing pages", {}, 0, 0, "open"],
    ]);
    expect(v.notOnMap).toEqual([{ topic: "Shop apps", count: 2, competitors: ["Rival", "Shopkeep"] }]);
  });

  it("shows only subjects they wrote about on a big map", () => {
    const v = coverageFrom(articles, competitors, subjects, { nowMs: NOW, allSubjects: false });
    expect(v.rows.map((r) => r.name)).toEqual(["Forms", "Ads", "SEO"]);
  });
});

describe("the page's view of an article", () => {
  it("keeps no lease or queue fields, and lists the pages it pushes once each", () => {
    const a = art("cmp_a", ["sub_forms"], {
      url: "https://rival.test/blog/x",
      title: "X",
      leaseId: "secret-ish",
      asks: [{ kind: "demo", placement: "end", url: "https://rival.test/demo", text: "Demo" }],
      links: [
        { url: "https://rival.test/demo", anchor: "Demo", role: "ask", internal: true },
        { url: "https://rival.test/features", anchor: "Features", role: "in_text", internal: true },
        { url: "https://rival.test/features", anchor: "Features again", role: "in_text", internal: true },
        { url: "https://rival.test/blog/y", anchor: "Y", role: "related", internal: true },
      ],
    });
    const v = articleViewOf(a);
    expect(v).not.toHaveProperty("leaseId");
    expect(v.pushes).toEqual([{ url: "https://rival.test/features", anchor: "Features" }]);
  });

  it("is null on a competitor's page when the brand doesn't have articles", () => {
    const c = { id: "cmp_a", name: "Rival", website: "https://rival.test", site: "rival.test", status: "watching", news: null, sitemap: null, analysis: null } as never;
    expect(detailOf(c, [], [], false)).toMatchObject({ articles: null, articleTotals: null, subjectNames: {} });
    expect(detailOf(c, [], [], false, { list: [art("cmp_a", [])], subjectNames: { sub_forms: "Forms" } })).toMatchObject({
      articleTotals: { read: 1 },
      subjectNames: { sub_forms: "Forms" },
    });
  });
});
