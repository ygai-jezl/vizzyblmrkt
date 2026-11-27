import type { Tenant } from "@/lib/types/tenant";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Removals from brand search are forced whatever the switches say (ADR-0025): an in-memory index stands in.
vi.mock("@/lib/tenant/searchIndex", async (original) => (await import("@/lib/search/testing/memorySearch")).withMemorySearch(await original<object>()));
import { MemorySearchIndex } from "@/lib/search/memoryStore";
import { forTenant } from "@/lib/tenant";
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
  listRecentReadArticles,
  monthlyCapReached,
  nearestCompetitorArticles,
  questionsNobodyCovers,
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

/** A record read this month, as the tenant layer stores it. */
const readRecord = (i: number) => ({
  tenantId: "ten_A",
  competitorId: "cmp_rival0001",
  url: `https://rival.test/blog/r-${i}`,
  title: `Read ${i}`,
  publishedAt: "2026-11-01",
  status: "read",
  queuedAt: "2026-11-01T00:00:00.000Z",
  readMonth: "2026-11",
});

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

  it("lists the reads of this month and the 3 before, read ones only, newest first, and only the brand's own", async () => {
    const d = deps("2026-11-26T12:00:00.000Z");
    const months = ["2026-11", "2026-10", "2026-09", "2026-08", "2026-07"];
    await queueArticles(A, "cmp_rival0001", months.map((_, i) => post(i + 1)), d);
    await queueArticles(B, "cmp_theirs001", [post(9, "cmp_theirs001")], d);
    for (const [i, month] of months.entries()) {
      const id = `cmp_rival0001_p${i + 1}`;
      await claimArticle(A, id, "l", d);
      await finishArticle(A, id, "l", { status: i === 1 ? "failed" : "read", readMonth: month }, d);
    }
    await claimArticle(B, "cmp_theirs001_p9", "l", d);
    await finishArticle(B, "cmp_theirs001_p9", "l", { status: "read", readMonth: "2026-11" }, d);
    // November, September and August: October failed, July is more than 3 months back.
    const recent = await listRecentReadArticles(A, { ...d, loadTenant: async () => null });
    expect(recent.articles.map((a) => a.id)).toEqual(["cmp_rival0001_p4", "cmp_rival0001_p3", "cmp_rival0001_p1"]);
    expect(recent.truncated).toBe(false);
    // Across a new year: January reads back to October.
    expect((await listRecentReadArticles(A, { ...d, loadTenant: async () => null, now: () => new Date("2027-01-05T00:00:00.000Z") })).articles.map((a) => a.id)).toEqual(["cmp_rival0001_p1"]);
  });

  it("reads each month up to the brand's cap and a margin, keeps read ones only, and says when a month had more", async () => {
    const d = deps("2026-11-26T12:00:00.000Z");
    const own = { featureLimits: { competitor_articles: 2 } } as unknown as Tenant;
    // 60 records read this month: skipped and failed ones carry the month too.
    for (let i = 1; i <= 60; i += 1) {
      d.db.seed("competitor_articles", `cmp_rival0001_r${i}`, { ...readRecord(i), status: i % 3 ? "read" : "skipped" } as never);
    }
    const capped = await listRecentReadArticles(A, { ...d, loadTenant: async () => own });
    // The cap of 2 and a margin of 50: 52 records looked at, the skipped ones among them left out.
    expect(capped.truncated).toBe(true);
    expect(capped.articles.every((a) => a.status === "read")).toBe(true);
    expect(capped.articles.length).toBeLessThanOrEqual(52);
    const roomy = await listRecentReadArticles(A, { ...d, loadTenant: async () => null });
    expect(roomy).toMatchObject({ truncated: false });
    expect(roomy.articles).toHaveLength(40);
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
    expect(await embedArticle(A, { id: "cmp_rival0001_p1", competitorId: "cmp_rival0001", title: "Post 1", question: "Q", angle: "", summary: "Forms" }, { ...d, embed })).toBe(true);
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

describe("meaning on brand search (ADR-0025)", () => {
  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  const unit = (v: number[]) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  /** brand search's model: forms point one way, pricing another, everything else a third. */
  const fresh = () =>
    vi.fn(async (items: Array<{ content: string; title?: string }>, _r: string, _t: string) =>
      items.map((i) => (/form/i.test(i.content) ? unit([1, 0.1, 0]) : /pricing/i.test(i.content) ? unit([0, 1, 0]) : unit([0, 0, 1]))),
    );

  async function withRead() {
    const d = deps();
    const search = new MemorySearchIndex().storeFor(A);
    const embedSearch = fresh();
    await forTenant(A, d.db).competitors.create("cmp_rival0001", { name: "Rival", site: "rival.test" } as never);
    await queueArticles(A, "cmp_rival0001", [post(1), post(2)], d);
    for (const [n, summary] of [[1, "Shorter forms convert better"], [2, "Pricing pages that sell"]] as const) {
      await claimArticle(A, `cmp_rival0001_p${n}`, "l", d);
      const done = await finishArticle(A, `cmp_rival0001_p${n}`, "l", { status: "read", summary, question: "", angle: "" }, d);
      await embedArticle(A, done!, { ...d, embed: async (items) => items.map(() => [0.1, 0.2]), search, embedSearch });
    }
    // The competitor's own summary sits beside its articles, with no status.
    await search.putSource(
      { sourceKey: "competitor:cmp_rival0001", kind: "competitor", ref: "cmp_rival0001", hash: "h", chunks: 1, embedded: true, indexedAt: "" },
      [{ tenantId: "ten_A", kind: "competitor", ref: "cmp_rival0001", sourceKey: "competitor:cmp_rival0001", chunk: 0, title: "Rival", text: "All about hiring", url: "", lang: "en", updatedAt: "", embedding: unit([0, 0, 1]) }],
      0,
    );
    return { d, search, embedSearch };
  }

  it("keeps each read article there as kept, titled with its competitor's name", async () => {
    const { search, embedSearch } = await withRead();
    expect((await search.listManifests()).map((m) => `${m.sourceKey} ${m.status ?? "none"}`).sort()).toEqual([
      "competitor:cmp_rival0001 none",
      "competitor:cmp_rival0001/cmp_rival0001_p1 kept",
      "competitor:cmp_rival0001/cmp_rival0001_p2 kept",
    ]);
    expect(embedSearch.mock.calls[0]![0]).toEqual([{ content: "Shorter forms convert better", title: "Rival: Post 1" }]);
  });

  it("reads brand search only with reads on, and a competitor's summary never answers", async () => {
    const { d, search, embedSearch } = await withRead();
    const old = vi.fn();
    const vectors = { where: () => vectors, findNearest: old } as unknown as KnowledgeCollectionLike;
    vi.stubEnv("SEARCH_COMPETITOR_READS_ENABLED", "true");
    const all = { ...d, search, embedSearch, vectors, query: vi.fn(async () => [1, 0]) };
    const near = await nearestCompetitorArticles(A, "Do short forms work?", { limit: 5, minSim: 0.5 }, all);
    expect(near.map((n) => n.article.id)).toEqual(["cmp_rival0001_p1"]);
    expect(embedSearch.mock.calls.at(-1)?.[2]).toBe("RETRIEVAL_QUERY");
    const questions = [
      { id: "q1", text: "Do short forms work?" },
      // Only the competitor's summary is near this one: it is still uncovered.
      { id: "q2", text: "How do I hire a designer?" },
    ];
    expect(await questionsNobodyCovers(A, questions, 0.9, all)).toEqual(["q2"]);
    // Meaning can't be checked: nothing is called uncovered by mistake.
    expect(await questionsNobodyCovers(A, questions, 0.9, { ...all, embedSearch: vi.fn(async (items: unknown[]) => items.map(() => null)) })).toBeNull();
    expect(old).not.toHaveBeenCalled();
    expect(all.query).not.toHaveBeenCalled();
  });

  it("takes a competitor's entries out at once when it is no longer watched, even with indexing off", async () => {
    const { d, search } = await withRead();
    vi.stubEnv("SEARCH_INDEX_ENABLED", "false");
    expect(await removeArticles(A, "cmp_rival0001", { ...d, search })).toBe(2);
    expect(await search.listManifests()).toEqual([]);
  });
});

