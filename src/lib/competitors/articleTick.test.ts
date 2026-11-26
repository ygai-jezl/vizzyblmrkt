import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Removals from brand search are forced whatever the switches say (ADR-0025): an in-memory index stands in.
vi.mock("@/lib/tenant/searchIndex", async (original) => (await import("@/lib/search/testing/memorySearch")).withMemorySearch(await original<object>()));
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { BrandMap } from "@/lib/types/brandMap";
import type { CompetitorArticle } from "@/lib/types/competitor";
import type { Tenant } from "@/lib/types/tenant";
import { usageThisMonth } from "@/lib/plans/meter";
import { listArticles } from "./articles";
import { runArticleReads, type ArticleTickDeps } from "./articleTick";
import { listPosts, monitorCompetitor, savePosts } from "./store";

/**
 * The article lane against a made-up competitor: its posts are queued (the newest 20 first), read
 * three a tick under leases, and each outcome lands where a person can see it.
 */

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const W = "https://rival.test";
const NOW = Date.parse("2026-11-17T12:00:00Z");
const tenant = (id: string, grantedFeatures: string[] = []) => ({ id, tenantName: "Acme", region: "us", grantedFeatures }) as unknown as Tenant;

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 7}`).join(" ");
const article = (title: string) =>
  `<html><head><title>${title}</title></head><body><article><h2>Why</h2><p>Sign ups rose 3x in a month for our customers. ${words(200)}</p><a href="/demo">Book a demo</a></article></body></html>`;

type Page = { status?: number; body: string; type?: string };
let web: Map<string, Page>;
let db: FakeFirestore;
let deps: ArticleTickDeps & { generate: ReturnType<typeof vi.fn>; embed: ReturnType<typeof vi.fn> };

const ANSWER = {
  summary: "Sign ups rose with better forms.",
  question: "How do I get more sign ups?",
  angle: "Forms beat traffic.",
  newTopic: "",
  format: "case_study",
  stage: "consideration",
  subjectIds: ["sub_signups"],
  reader: { roles: ["Shop owners"], companies: "Small shops", pains: ["Flat sign ups"] },
  stats: [{ figure: "3x", about: "Sign ups", quote: "Sign ups rose 3x in a month for our customers.", kind: "result", theirOwn: true, sourceLink: 0 }],
  links: [{ n: 1, role: "ask" }],
  ctas: [{ n: 1, kind: "demo", placement: "end" }],
  productsPushed: [],
};

const fetch = (async (url: string) => {
  const page = web.get(url);
  const res = page ? new Response(page.body, { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html" } }) : new Response("no", { status: 404 });
  Object.defineProperty(res, "url", { value: url });
  return res;
}) as unknown as ArticleTickDeps["fetch"];

const MAP = {
  rev: 1,
  identity: { name: "Acme", category: "", statement: "", isNot: [], avoid: [], site: "", profiles: [], categorySameAs: [] },
  subjects: [{ id: "sub_signups", name: "Getting more sign ups", home: null, questions: [] }],
  names: [],
} as unknown as BrandMap;

async function competitor(posts: number, opts: { reader?: "google"; status?: "paused" } = {}): Promise<string> {
  const r = await monitorCompetitor(A, { website: "rival.test", name: "Rival" }, { db });
  if (!r.ok) throw new Error(r.error);
  const id = r.value.competitor.id;
  await forTenant(A, db).competitors.update(id, {
    status: opts.status ?? "watching",
    stage: null,
    reader: opts.reader ?? "direct",
    news: { url: `${W}/blog`, feedUrl: null, chosenBy: "manual", baselineAt: "2026-11-10T00:00:00.000Z", checkedAt: null },
    lastPostsCheckAt: "2026-11-10T00:00:00.000Z",
  });
  await savePosts(
    A,
    id,
    Array.from({ length: posts }, (_, i) => ({
      url: `${W}/blog/post-${i + 1}`,
      title: `Post ${i + 1}`,
      description: "",
      publishedAt: `2026-10-${String(i + 1).padStart(2, "0")}`,
      firstSeenAt: "2026-11-10T00:00:00.000Z",
      baseline: true,
    })),
    { db },
  );
  for (let i = 1; i <= posts; i++) web.set(`${W}/blog/post-${i}`, { body: article(`Post ${i}`) });
  return id;
}

const tick = (extra: Partial<ArticleTickDeps> = {}, deadline = NOW + 40_000) =>
  runArticleReads({ deadlineMs: deadline }, { ...deps, listTenants: async () => [tenant("ten_A", ["competitors", "competitor_articles"])], ...extra });

const byStatus = (list: CompetitorArticle[]) => list.reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {});

beforeEach(() => {
  db = new FakeFirestore();
  web = new Map([[`${W}/robots.txt`, { body: "User-agent: *\nDisallow: /private\n", type: "text/plain" }]]);
  deps = {
    db,
    fetch,
    clock: () => NOW,
    now: () => new Date(NOW),
    generate: vi.fn(async () => JSON.stringify(ANSWER)),
    embed: vi.fn(async (items: Array<{ content: string }>) => items.map(() => [0.1, 0.2])),
    loadMap: async () => MAP,
  };
  vi.stubEnv("COMPETITORS_ENABLED", "true");
  vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("runArticleReads", () => {
  it("does nothing with its switch off", async () => {
    vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "false");
    const listTenants = vi.fn(async () => [tenant("ten_A")]);
    expect(await runArticleReads({ deadlineMs: NOW + 40_000 }, { ...deps, listTenants })).toMatchObject({ tenants: 0, read: 0 });
    expect(listTenants).not.toHaveBeenCalled();
  });

  it("skips a brand without the grant where the feature is kept for granted brands", async () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitors,competitor_articles");
    await competitor(3);
    const r = await runArticleReads({ deadlineMs: NOW + 40_000 }, { ...deps, listTenants: async () => [tenant("ten_A", ["competitors"])] });
    expect(r).toMatchObject({ tenants: 0, read: 0 });
  });

  it("queues the newest 20 posts the first time, and reads three a tick", async () => {
    const id = await competitor(25);
    expect(await tick()).toMatchObject({ tenants: 1, queued: 20, read: 3 });
    let list = await listArticles(A, id, deps);
    expect(byStatus(list)).toEqual({ read: 3, queued: 17 });
    // The newest first: posts 25, 24 and 23.
    expect(list.filter((a) => a.status === "read").map((a) => a.title)).toEqual(["Post 25", "Post 24", "Post 23"]);
    const one = list.find((a) => a.title === "Post 25")!;
    expect(one).toMatchObject({
      readBy: "direct",
      readMonth: "2026-11",
      version: 3,
      subjectIds: ["sub_signups"],
      format: "case_study",
      asks: [{ kind: "demo", url: `${W}/demo` }],
      stats: [{ figure: "3x", theirOwn: true }],
      leaseId: null,
    });
    expect(deps.embed).toHaveBeenCalledTimes(3);

    // Nothing new was checked, so nothing more is queued; three more are read.
    expect(await tick()).toMatchObject({ queued: 0, read: 3 });
    list = await listArticles(A, id, deps);
    expect(byStatus(list)).toEqual({ read: 6, queued: 14 });
  });

  it("queues only posts first seen after the last look", async () => {
    const id = await competitor(2);
    await tick();
    await savePosts(A, id, [{ url: `${W}/blog/new`, title: "New", description: "", publishedAt: "2026-11-16", firstSeenAt: "2026-11-17T12:30:00.000Z", baseline: false }], { db });
    web.set(`${W}/blog/new`, { body: article("New") });
    await forTenant(A, db).competitors.update(id, { lastPostsCheckAt: "2026-11-17T12:30:00.000Z" });
    expect(await tick({ clock: () => NOW + 3_600_000, now: () => new Date(NOW + 3_600_000) }, NOW + 3_600_000 + 40_000)).toMatchObject({ queued: 1, read: 1 });
  });

  it("says why an article wasn't read: gone, refused, kept out by robots.txt, or too short", async () => {
    const id = await competitor(4);
    web.delete(`${W}/blog/post-4`);
    web.set(`${W}/blog/post-3`, { status: 403, body: "no" });
    web.set(`${W}/robots.txt`, { body: "User-agent: *\nDisallow: /blog/post-2\n", type: "text/plain" });
    await tick();
    web.set(`${W}/blog/post-1`, { body: "<html><body><article><p>Too short.</p></article></body></html>" });
    await tick();
    await tick();
    const list = await listArticles(A, id, deps);
    const of = (t: string) => list.find((a) => a.title === t)!;
    expect([of("Post 4").status, of("Post 4").problem]).toEqual(["skipped", "removed"]);
    expect([of("Post 3").status, of("Post 3").problem, of("Post 3").attempts]).toEqual(["failed", "turned_away", 2]);
    expect([of("Post 2").status, of("Post 2").problem]).toEqual(["skipped", "blocked"]);
    expect([of("Post 1").status, of("Post 1").problem]).toEqual(["skipped", "not_an_article"]);
    // No model call was made for any of them, so none counts against the month.
    expect(list.every((a) => a.readMonth === null)).toBe(true);
  });

  it("tries a read the model didn't answer once more, and counts both against the month", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const id = await competitor(1);
    deps.generate.mockResolvedValue(null);
    await tick();
    expect((await listArticles(A, id, deps))[0]).toMatchObject({ status: "queued", problem: "no_answer", attempts: 1, readMonth: "2026-11" });
    await tick();
    expect((await listArticles(A, id, deps))[0]).toMatchObject({ status: "failed", problem: "no_answer", attempts: 2 });
    // The usage meter counts both model calls too, in the tick's month.
    expect((await usageThisMonth(A, { db: deps.db, now: () => new Date(NOW) })).competitor_reads).toMatchObject({ total: 2, byPurpose: { competitor_articles: 2 } });
  });

  it("stops at the brand's monthly cap", async () => {
    vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "true");
    await competitor(2);
    const repo = forTenant(A, db).competitorArticles;
    for (let i = 0; i < 200; i++) await repo.create(`old_${i}`, { competitorId: "cmp_gone", readMonth: "2026-11", status: "read" } as never);
    expect(await tick()).toMatchObject({ queued: 2, read: 0 });
  });

  it("stops at the brand's own cap when it has one (src/lib/plans/limits.ts)", async () => {
    vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "true");
    await competitor(2);
    const repo = forTenant(A, db).competitorArticles;
    await repo.create("old_0", { competitorId: "cmp_gone", readMonth: "2026-11", status: "read" } as never);
    const capped = { ...tenant("ten_A", ["competitors", "competitor_articles"]), featureLimits: { competitor_articles: 1 } };
    expect(await tick({ listTenants: async () => [capped] })).toMatchObject({ queued: 2, read: 0 });
  });

  it("starts no read without enough time left, and leaves a paused competitor's articles waiting", async () => {
    await competitor(2);
    expect(await tick({}, NOW + 20_000)).toMatchObject({ tenants: 0, read: 0 });
    const db2 = new FakeFirestore();
    db = db2;
    deps.db = db2;
    await competitor(2, { status: "paused" });
    expect(await tick()).toMatchObject({ queued: 0, read: 0 });
  });

  it("reads a site that turns us away through Google, topic and reader only, and only with that switch on", async () => {
    const id = await competitor(1, { reader: "google" });
    const readWithGoogle = vi.fn(async () => ({ text: JSON.stringify(ANSWER), retrieved: [{ url: `${W}/blog/post-1`, status: "URL_RETRIEVAL_STATUS_SUCCESS" }], model: "m" }));
    await tick({ readWithGoogle });
    expect((await listArticles(A, id, deps))[0]).toMatchObject({ status: "failed", problem: "turned_away" });
    expect(readWithGoogle).not.toHaveBeenCalled();

    vi.stubEnv("COMPETITORS_GOOGLE_READER_ENABLED", "true");
    const id2 = await (async () => {
      db = new FakeFirestore();
      deps.db = db;
      return competitor(1, { reader: "google" });
    })();
    await tick({ readWithGoogle });
    expect((await listArticles(A, id2, deps))[0]).toMatchObject({ status: "read", readBy: "google", format: "case_study", stats: [], links: [], asks: [] });
    expect(deps.generate).not.toHaveBeenCalled();
  });
});

describe("reading again what an older reader read", () => {
  const older = async (id: string, title: string, over: Partial<CompetitorArticle> = {}) => {
    const a = (await listArticles(A, id, deps)).find((x) => x.title === title)!;
    await forTenant(A, db).competitorArticles.update(a.id, {
      version: 1,
      summary: "What the older reader said.",
      stats: [{ figure: "512 tokens", about: "A setting", quote: "x", theirOwn: true, source: null }],
      ...over,
    });
    return a.id;
  };
  const one = async (id: string) => (await forTenant(A, db).competitorArticles.getById(id))!;

  it("reads it again only when nothing new is waiting, and keeps only results this time", async () => {
    const id = await competitor(4);
    await tick();
    const old = await older(id, "Post 4");
    // Post 1 is still waiting, so it goes first.
    expect(await tick()).toMatchObject({ read: 1, refreshed: 0 });
    expect((await one(old)).version).toBe(1);
    expect(await tick()).toMatchObject({ read: 0, refreshed: 1 });
    expect(await one(old)).toMatchObject({ status: "read", version: 3, summary: ANSWER.summary, stats: [{ figure: "3x" }], leaseId: null });
    expect(await tick()).toMatchObject({ read: 0, refreshed: 0 });
  });

  it("skips a page that only lists other posts, also when reading it again, and saves titles without the site's name", async () => {
    const id = await competitor(2);
    await tick();
    const listing = await older(id, "Post 2");
    const named = await older(id, "Post 1", { title: "Post 1 | Rival" });
    deps.generate.mockImplementation(async (prompt: string) => JSON.stringify(prompt.includes("Post 2") ? { ...ANSWER, format: "listing" } : ANSWER));
    expect(await tick()).toMatchObject({ refreshed: 1, skipped: 1 });
    expect(await one(listing)).toMatchObject({ status: "skipped", problem: "listing", version: 3, leaseId: null });
    expect(await one(named)).toMatchObject({ status: "read", title: "Post 1", version: 3 });
    expect(await tick()).toMatchObject({ refreshed: 0, skipped: 0 });
  });

  it("keeps read articles in brand search, and takes one out at once when reading again finds a listing (ADR-0025)", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
    const { testSearchIndex } = await import("@/lib/search/testing/memorySearch");
    const index = testSearchIndex.storeFor(A);
    await index.clear();
    const id = await competitor(2);
    await tick();
    const entries = async () => (await index.listManifests()).map((m) => `${m.sourceKey} ${m.status}`).sort();
    const [p1, p2] = (await listArticles(A, id, deps)).sort((a, b) => a.title.localeCompare(b.title));
    expect(await entries()).toEqual([`competitor:${id}/${p1!.id} kept`, `competitor:${id}/${p2!.id} kept`]);
    await older(id, "Post 2");
    vi.stubEnv("SEARCH_INDEX_ENABLED", "false");
    deps.generate.mockImplementation(async (prompt: string) => JSON.stringify(prompt.includes("Post 2") ? { ...ANSWER, format: "listing" } : ANSWER));
    expect(await tick()).toMatchObject({ skipped: 1 });
    expect(await entries()).toEqual([`competitor:${id}/${p1!.id} kept`]);
  });

  it("keeps what the older reader found when reading again finds nothing, and doesn't try it again", async () => {
    const id = await competitor(2);
    await tick();
    const silent = await older(id, "Post 2");
    const gone = await older(id, "Post 1");
    web.delete(`${W}/blog/post-1`);
    deps.generate.mockResolvedValue(null);
    await tick();
    for (const x of [silent, gone]) expect(await one(x)).toMatchObject({ status: "read", version: 3, problem: null, summary: "What the older reader said.", stats: [{ figure: "512 tokens" }] });
    const calls = deps.generate.mock.calls.length;
    expect(await tick()).toMatchObject({ refreshed: 0, failed: 0 });
    expect(deps.generate.mock.calls.length).toBe(calls);
  });

  it("keeps 50 of the month's reads for new posts, and leaves reads through Google alone", async () => {
    const id = await competitor(2);
    await tick();
    const old = await older(id, "Post 2");
    const google = await older(id, "Post 1", { readBy: "google" });
    const repo = forTenant(A, db).competitorArticles;
    // Read this month for a competitor that is no longer watched, by an older reader too: never read again.
    for (let i = 0; i < 148; i++) await repo.create(`old_${i}`, { competitorId: "cmp_gone", readMonth: "2026-11", status: "read", readBy: "direct", version: 1, queuedAt: "2026-11-01T00:00:00.000Z" } as never);
    expect(await tick()).toMatchObject({ refreshed: 0 });
    expect((await one(old)).version).toBe(1);
    await repo.delete("old_0");
    expect(await tick()).toMatchObject({ refreshed: 1 });
    expect((await one(old)).version).toBe(3);
    expect((await one(google)).version).toBe(1);
  });
});

describe("dating posts stored without dates", () => {
  /** A competitor whose stored posts have no dates (a sitemap without them), its first pick already made. */
  async function undated(posts: number): Promise<string> {
    const id = await competitor(posts);
    const repo = forTenant(A, db).competitorPosts;
    for (const p of await listPosts(A, id, { db })) await repo.update(p.id, { publishedAt: null });
    await tick();
    return id;
  }
  /** Their news page, newest first, a date on every card: post N was published on N October. */
  const listing = (posts: number) =>
    `<html><body><a href="/blog/category">Category</a>${Array.from({ length: posts }, (_, i) => posts - i)
      .map((n) => `<a href="/blog/post-${n}"><p>${n} Oct, 2026</p><h3>Post ${n}</h3></a>`)
      .join("")}</body></html>`;
  const fetched = () => {
    const urls: string[] = [];
    const base = deps.fetch!;
    deps.fetch = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      return base(url, init as never);
    }) as unknown as ArticleTickDeps["fetch"];
    return urls;
  };
  const one = async (id: string) => (await forTenant(A, db).competitors.getById(id))!;

  it("dates them from the news page once, then queues the newest", async () => {
    const id = await undated(25);
    web.set(`${W}/blog`, { body: listing(25) });
    const urls = fetched();
    await tick();
    expect(urls.filter((u) => u === `${W}/blog`)).toHaveLength(1);
    const posts = await listPosts(A, id, { db });
    expect(posts.find((p) => p.url.endsWith("/post-25"))).toMatchObject({ publishedAt: "2026-10-25", rank: 0 });
    expect(posts.every((p) => p.publishedAt)).toBe(true);
    expect((await one(id)).postsDatedAt).toBeTruthy();
    // Posts 6 to 25 are the newest 20: each is now queued or read.
    const queued = new Set((await listArticles(A, id, deps)).map((a) => a.url));
    for (let n = 6; n <= 25; n++) expect(queued.has(`${W}/blog/post-${n}`)).toBe(true);
    // Never again.
    await tick();
    expect(urls.filter((u) => u === `${W}/blog`)).toHaveLength(1);
  });

  it("only marks a competitor whose posts have dates, or whose news page can't be read", async () => {
    const dated = await competitor(3);
    await tick();
    const urls = fetched();
    await tick();
    expect((await one(dated)).postsDatedAt).toBeTruthy();
    expect(urls.filter((u) => u === `${W}/blog`)).toHaveLength(0);

    db = new FakeFirestore();
    deps.db = db;
    const gone = await undated(3);
    await tick();
    expect((await one(gone)).postsDatedAt).toBeTruthy();
    expect((await listPosts(A, gone, { db })).every((p) => p.publishedAt === null)).toBe(true);
  });
});
