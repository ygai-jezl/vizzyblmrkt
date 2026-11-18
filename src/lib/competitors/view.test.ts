import { describe, expect, it } from "vitest";
import type { CompetitorArticle, CompetitorSection } from "@/lib/types/competitor";
import { articleTotals, articleViewOf, changeSummaryOf, listWords, roleKey } from "./view";

const art = (over: Partial<CompetitorArticle>): CompetitorArticle =>
  ({
    id: "a1",
    url: "https://rival.test/blog/a",
    title: "A post | Rival",
    status: "read",
    readBy: "direct",
    publishedAt: "2026-10-01",
    format: "case_study",
    stage: "consideration",
    reader: { roles: [], companies: "", pains: [] },
    asks: [],
    links: [],
    sources: [],
    stats: [],
    mentions: { you: [], others: [], products: [] },
    trust: { author: null, authorUrl: null, publishedAt: null, updatedAt: null, schemaTypes: [] },
    ...over,
  }) as CompetitorArticle;

describe("roleKey", () => {
  it("counts singular and plural, and any case, as one role", () => {
    expect(roleKey("Heads of SEO")).toBe(roleKey("head of SEO"));
    expect(roleKey("marketers")).toBe(roleKey("Marketer"));
    expect(roleKey("Agencies")).toBe(roleKey("agency"));
    expect(roleKey("Sales leads")).not.toBe(roleKey("Sale"));
    expect(roleKey("SEO professionals")).not.toBe(roleKey("Heads of SEO"));
  });
});

describe("articleTotals", () => {
  it("merges a role's forms and shows the one used most, with the kind of company", () => {
    const t = articleTotals([
      art({ reader: { roles: ["SEO professionals", "marketers"], companies: "software companies", pains: [] } }),
      art({ reader: { roles: ["SEO professional", "Marketers"], companies: "software companies", pains: [] } }),
      art({ reader: { roles: ["SEO professionals", "marketer"], companies: "", pains: [] } }),
    ]);
    expect(t.roles).toEqual([
      { key: "Marketers", count: 3 },
      { key: "SEO professionals", count: 3 },
    ]);
    expect(t.companies).toEqual([{ key: "software companies", count: 2 }]);
  });

  it("names the pages they push by their link words and site section, and drops asks we can't name", () => {
    const sections: CompetitorSection[] = [
      { path: "/features/", label: "Features", purpose: "", pages: 9 },
      { path: "/", label: "Home", purpose: "", pages: 1 },
    ];
    const one = art({
      asks: [
        { kind: "other", placement: "inline", url: "https://rival.test/features/prompt-volumes", text: "Prompt Volumes" },
        { kind: "demo", placement: "end", url: "https://rival.test/contact-sales", text: "request a demo" },
      ],
      links: [
        { url: "https://rival.test/features/prompt-volumes", anchor: "Prompt Volumes", role: "ask", internal: true },
        { url: "https://rival.test/contact-sales", anchor: "request a demo", role: "ask", internal: true },
        { url: "https://rival.test/features/agents", anchor: "here", role: "in_text", internal: true },
        { url: "https://rival.test/features/agents", anchor: "Agents", role: "mention", internal: true },
      ],
    });
    const t = articleTotals([one, art({ links: [{ url: "https://rival.test/features/prompt-volumes/", anchor: "prompt volumes", role: "in_text", internal: true }] })], sections);
    expect(t.asks).toEqual([{ key: "demo", count: 1 }]);
    expect(t.pushed).toEqual([
      { key: "/features/prompt-volumes", count: 2, name: "Prompt Volumes", section: "Features" },
      { key: "/contact-sales", count: 1, name: "Request a demo", section: null },
      { key: "/features/agents", count: 1, name: "Agents", section: "Features" },
    ]);
  });

  it("cites outside pages only, never a file host, and says when the articles were published", () => {
    const t = articleTotals([
      art({
        publishedAt: "2025-07-17",
        sources: [
          { url: "https://research.example.org/a", domain: "research.example.org", anchor: "study" },
          { url: "https://1.fs1.hubspotusercontent-na1.net/x.pdf", domain: "1.fs1.hubspotusercontent-na1.net", anchor: "this" },
        ],
      }),
      art({ publishedAt: "2026-10-16" }),
      art({ publishedAt: null }),
    ]);
    expect(t.cited).toEqual([{ key: "research.example.org", count: 1 }]);
    expect(t.span).toEqual({ from: "2025-07-17", to: "2026-10-16" });
  });
});

describe("articleViewOf", () => {
  it("cleans the title, keeps named asks, and lists links that only name someone apart from sources", () => {
    const v = articleViewOf(
      art({
        title: "Rival raises its Series C | Rival",
        asks: [{ kind: "other", placement: "inline", url: "https://rival.test/careers", text: "explore our open roles" }],
        links: [
          { url: "https://rival.test/careers", anchor: "explore our open roles", role: "ask", internal: true },
          { url: "https://investor.example.com/", anchor: "Example Ventures", role: "mention", internal: false },
          { url: "https://investor.example.com/", anchor: "Example Ventures", role: "mention", internal: false },
        ],
        sources: [{ url: "https://cdn.example.cloudfront.net/x.pdf", domain: "cdn.example.cloudfront.net", anchor: "this" }],
      }),
      ["Rival", "rival.test"],
    );
    expect(v.title).toBe("Rival raises its Series C");
    expect(v.asks).toEqual([]);
    expect(v.pushes).toEqual([{ url: "https://rival.test/careers", anchor: "explore our open roles" }]);
    expect(v.mentionLinks).toEqual([{ url: "https://investor.example.com/", anchor: "Example Ventures" }]);
    expect(v.sources).toEqual([]);
  });
});

describe("changeSummaryOf", () => {
  const asks = (kind: "trial" | "demo") => [{ kind, placement: "end" as const, url: `https://rival.test/${kind}`, text: kind }];
  const read = new Map([
    ["https://rival.test/1", art({ format: "case_study", reader: { roles: ["SEO leads"], companies: "", pains: [] }, asks: asks("trial") })],
    ["https://rival.test/2", art({ format: "case_study", reader: { roles: ["SEO lead"], companies: "", pains: [] }, asks: asks("trial") })],
    ["https://rival.test/3", art({ format: "how_to", reader: { roles: ["Marketers"], companies: "", pains: [] }, asks: asks("demo") })],
    ["https://rival.test/4", art({ status: "queued" })],
  ]);
  const posts = (...n: number[]) => n.map((i) => ({ url: `https://rival.test/${i}` }));

  it("says what one article is, who it is for and what it asks", () => {
    expect(changeSummaryOf(posts(3), read)).toBe("1 how to, for marketers. It asks for a demo.");
  });

  it("counts kinds and says when all of them ask the same", () => {
    expect(changeSummaryOf(posts(1, 2), read)).toBe("2 case studies, for SEO leads. Both ask for a free trial.");
  });

  it("says how many ask, and what is still to read", () => {
    expect(changeSummaryOf(posts(1, 2, 3, 4), read)).toBe("2 case studies and 1 how to, for SEO leads. 2 of 3 ask for a free trial. 1 more still to read.");
  });

  it("is null until one of them is read", () => {
    expect(changeSummaryOf(posts(4, 5), read)).toBeNull();
  });
});

describe("listWords", () => {
  it("joins with commas and a last word", () => {
    expect(listWords(["a"])).toBe("a");
    expect(listWords(["a", "b"])).toBe("a and b");
    expect(listWords(["a case study", "research", "a how to"], "or")).toBe("a case study, research or a how to");
  });
});
