import type { Tenant } from "@/lib/types/tenant";
import { describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import type { CompetitorArticle, CompetitorPost } from "@/lib/types/competitor";
import {
  ARTICLE_LEASE_MS,
  articlesOnSubject,
  articlesToRead,
  claimArticle,
  embedArticle,
  finishArticle,
  listArticles,
  monthlyCapReached,
  nearestCompetitorArticles,
  queueArticles,
  readsThisMonth,
  removeArticles,
  type ArticleStoreDeps,
} from "./articles";
import { articleTotals } from "./view";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };

const post = (n: number, competitorId = "cmp_rival0001", day = `2026-11-${String(n).padStart(2, "0")}`): CompetitorPost => ({
  id: `${competitorId}_p${n}`,
  tenantId: "ten_A",
  competitorId,
  url: `https://rival.test/blog/post-${n}`,
  title: `Post ${n}`,
  description: "",
  publishedAt: day,
  firstSeenAt: "2026-11-17T00:00:00.000Z",
  baseline: false,
});

function deps(at = "2026-11-17T12:00:00.000Z"): ArticleStoreDeps & { db: FakeFirestore; clock: { t: number } } {
  const clock = { t: Date.parse(at) };
  return { db: new FakeFirestore(), now: () => new Date(clock.t), clock };
}

describe("the article queue", () => {
  it("queues each post once, and only the competitor's own", async () => {
    const d = deps();
    expect(await queueArticles(A, "cmp_rival0001", [post(1), post(2), post(3, "cmp_other0001")], d)).toBe(2);
    expect(await queueArticles(A, "cmp_rival0001", [post(1), post(4)], d)).toBe(1);
    const list = await listArticles(A, "cmp_rival0001", d);
    expect(list.map((a) => [a.id, a.status, a.url, a.title])).toEqual([
      ["cmp_rival0001_p4", "queued", "https://rival.test/blog/post-4", "Post 4"],
      ["cmp_rival0001_p2", "queued", "https://rival.test/blog/post-2", "Post 2"],
      ["cmp_rival0001_p1", "queued", "https://rival.test/blog/post-1", "Post 1"],
    ]);
  });

  it("hands an article to one reader at a time, and takes it back when a reader stops without finishing", async () => {
    const d = deps();
    await queueArticles(A, "cmp_rival0001", [post(1)], d);
    const first = await claimArticle(A, "cmp_rival0001_p1", "lease-1", d);
    expect(first).toMatchObject({ status: "reading", leaseId: "lease-1", attempts: 1 });
    expect(await claimArticle(A, "cmp_rival0001_p1", "lease-2", d)).toBeNull();
    expect(await articlesToRead(A, 5, d)).toEqual([]);

    d.clock.t += ARTICLE_LEASE_MS + 1;
    expect((await articlesToRead(A, 5, d)).map((a) => a.id)).toEqual(["cmp_rival0001_p1"]);
    expect(await claimArticle(A, "cmp_rival0001_p1", "lease-2", d)).toMatchObject({ leaseId: "lease-2", attempts: 2 });
    // The first reader comes back late: its findings are not saved over the second's.
    expect(await finishArticle(A, "cmp_rival0001_p1", "lease-1", { status: "read" }, d)).toBeNull();
    expect(await finishArticle(A, "cmp_rival0001_p1", "lease-2", { status: "read", summary: "S", readMonth: "2026-11" }, d)).toMatchObject({
      status: "read",
      leaseId: null,
      leaseUntil: null,
    });
  });

  it("counts this month's reads against the brand's cap", async () => {
    const d = deps();
    await queueArticles(A, "cmp_rival0001", [post(1), post(2)], d);
    for (const id of ["cmp_rival0001_p1", "cmp_rival0001_p2"]) {
      await claimArticle(A, id, "l", d);
      await finishArticle(A, id, "l", { status: "read", readMonth: id.endsWith("1") ? "2026-11" : "2026-10" }, d);
    }
    expect(await readsThisMonth(A, d)).toBe(1);
    expect(await monthlyCapReached(A, { ...d, loadTenant: async () => null })).toBe(false);
    // The brand's own cap (src/lib/plans/limits.ts) is what counts.
    const own = { featureLimits: { competitor_articles: 1 } } as unknown as Tenant;
    expect(await monthlyCapReached(A, { ...d, loadTenant: async () => own })).toBe(true);
  });

  it("removes a competitor's articles and their vectors, and a read in progress then saves nothing", async () => {
    const d = deps();
    await queueArticles(A, "cmp_rival0001", [post(1), post(2)], d);
    await claimArticle(A, "cmp_rival0001_p1", "l", d);
    expect(await removeArticles(A, "cmp_rival0001", d)).toBe(2);
    expect(await finishArticle(A, "cmp_rival0001_p1", "l", { status: "read" }, d)).toBeNull();
    expect(await listArticles(A, "cmp_rival0001", d)).toEqual([]);
  });
});

describe("one brand never sees another's articles", () => {
  it("can't list, claim, finish or remove them", async () => {
    const d = deps();
    await queueArticles(A, "cmp_rival0001", [post(1)], d);
    expect(await listArticles(B, "cmp_rival0001", d)).toEqual([]);
    expect(await articlesToRead(B, 5, d)).toEqual([]);
    expect(await claimArticle(B, "cmp_rival0001_p1", "l", d)).toBeNull();
    expect(await finishArticle(B, "cmp_rival0001_p1", "l", { status: "read" }, d)).toBeNull();
    expect(await removeArticles(B, "cmp_rival0001", d)).toBe(0);
    expect(await listArticles(A, "cmp_rival0001", d)).toHaveLength(1);
  });
});

describe("meaning", () => {
  it("embeds a read article and finds the read ones nearest some text", async () => {
    const d = deps();
    await queueArticles(A, "cmp_rival0001", [post(1), post(2)], d);
    await claimArticle(A, "cmp_rival0001_p1", "l", d);
    await finishArticle(A, "cmp_rival0001_p1", "l", { status: "read", summary: "Forms", subjectIds: ["sub_forms"] }, d);
    const embed = vi.fn(async (items: Array<{ content: string }>) => items.map(() => [0.1, 0.2]));
    expect(await embedArticle(A, { id: "cmp_rival0001_p1", title: "Post 1", question: "Q", angle: "", summary: "Forms" }, { ...d, embed })).toBe(true);
    expect(embed.mock.calls[0]![0]![0]!.content).toBe("Post 1\nQ\nForms");

    const rows = [
      { tenantId: "ten_A", kind: "competitor_article", ref: "cmp_rival0001_p1", status: "kept", _distance: 0.1 },
      { tenantId: "ten_A", kind: "competitor_article", ref: "cmp_rival0001_p2", status: "kept", _distance: 0.2 },
    ];
    const vectors: KnowledgeCollectionLike = {
      where: () => vectors,
      findNearest: () => ({ get: async () => ({ empty: false, size: rows.length, docs: rows.map((r, i) => ({ id: `v${i}`, data: () => r })) }) }),
    };
    const near = await nearestCompetitorArticles(A, "forms", { limit: 5 }, { ...d, vectors, query: async () => [1, 0] });
    // The second is still queued: only read articles count.
    expect(near.map((n) => n.article.id)).toEqual(["cmp_rival0001_p1"]);
    expect((await articlesOnSubject(A, "sub_forms", d)).map((a) => a.id)).toEqual(["cmp_rival0001_p1"]);
  });
});

describe("articleTotals", () => {
  const read = (over: Partial<CompetitorArticle>): CompetitorArticle =>
    ({
      status: "read",
      readBy: "direct",
      format: "case_study",
      stage: "consideration",
      reader: { roles: ["SEO managers"], companies: "", pains: [] },
      asks: [{ kind: "demo", placement: "end", url: "https://rival.test/demo", text: "Demo" }],
      links: [
        { url: "https://rival.test/demo", anchor: "Demo", role: "ask", internal: true },
        { url: "https://rival.test/demo/", anchor: "Demo again", role: "in_text", internal: true },
        { url: "https://rival.test/authors/ana", anchor: "Ana", role: "author", internal: true },
      ],
      sources: [{ url: "https://research.example.org/a", domain: "research.example.org", anchor: "a" }],
      stats: [{ figure: "2x", about: "", quote: "", theirOwn: true, source: null }],
      ...over,
    }) as CompetitorArticle;

  it("counts formats, readers, asks, the pages they push and who they cite", () => {
    const t = articleTotals([read({}), read({ format: "opinion", readBy: "google", asks: [], links: [], sources: [], stats: [] }), read({ status: "queued" })]);
    expect(t).toMatchObject({
      read: 2,
      waiting: 1,
      readThroughGoogle: 1,
      formats: [
        { key: "case_study", count: 1 },
        { key: "opinion", count: 1 },
      ],
      roles: [{ key: "SEO managers", count: 2 }],
      asks: [{ key: "demo", count: 1 }],
      pushed: [{ key: "/demo", count: 1 }],
      cited: [{ key: "research.example.org", count: 1 }],
      stats: { total: 1, theirOwn: 1 },
    });
  });
});
