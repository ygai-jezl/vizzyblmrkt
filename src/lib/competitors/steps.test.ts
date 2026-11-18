import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Competitor } from "@/lib/types/competitor";
import { advanceCompetitor, nextStep, type StepDeps } from "./steps";
import { listChanges, listPosts, monitorCompetitor } from "./store";

/**
 * A competitor's whole life against a made-up site: found through robots.txt, read through a
 * sitemap index (one child gzipped), labelled, its news page's feed kept as the baseline, then a
 * week with a new post and a month with pages added and removed.
 */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const other: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const W = "https://www.acme-dental.example";

type Page = { status?: number; body: string | Buffer; type?: string };
let web: Map<string, Page>;
let fetched: string[];

const urlset = (...paths: Array<[string, string?]>) =>
  `<?xml version="1.0"?><urlset>${paths.map(([p, d]) => `<url><loc>${W}${p}</loc>${d ? `<lastmod>${d}</lastmod>` : ""}</url>`).join("")}</urlset>`;
const rss = (...items: Array<[string, string]>) =>
  `<rss><channel>${items.map(([slug, title]) => `<item><title>${title}</title><link>${W}/news/${slug}</link><pubDate>Mon, 09 Nov 2026 09:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`;

function site() {
  web = new Map<string, Page>([
    [`${W}/robots.txt`, { body: `User-agent: *\nDisallow: /private\nSitemap: ${W}/sitemap_index.xml\n`, type: "text/plain" }],
    [`${W}/sitemap_index.xml`, { body: `<sitemapindex><sitemap><loc>${W}/page-sitemap.xml</loc></sitemap><sitemap><loc>${W}/post-sitemap.xml.gz</loc></sitemap><sitemap><loc>https://elsewhere.example/s.xml</loc></sitemap></sitemapindex>` }],
    [`${W}/page-sitemap.xml`, { body: urlset(["/"], ["/treatments/implants"], ["/treatments/whitening"], ["/pricing"], ["/news"]) }],
    [`${W}/post-sitemap.xml.gz`, { body: gzipSync(urlset(["/news/a", "2026-10-01"], ["/news/b", "2026-10-20"], ["/news/c", "2026-11-02"])), type: "application/x-gzip" }],
    [`${W}/news`, { body: `<html><head><link rel="alternate" type="application/rss+xml" href="/news/feed/"></head><body><a href="/news/a">A</a></body></html>`, type: "text/html" }],
    [`${W}/news/feed/`, { body: rss(["c", "Opening hours"], ["b", "Whitening myths"], ["a", "Implants explained"]), type: "application/rss+xml" }],
    [`${W}/news/d`, { body: `<html><head><title>A new clinic in Leeds</title><meta name="description" content="We open in Leeds in December."><meta property="article:published_time" content="2026-11-14T08:00:00Z"></head></html>`, type: "text/html" }],
  ]);
}

/** Like safeFetch after its redirects: the bare domain answers from www, and says so in `url`. */
const fakeFetch = (async (raw: string) => {
  fetched.push(raw);
  const url = raw.replace("https://acme-dental.example/", `${W}/`);
  const page = web.get(url);
  const res = page
    ? new Response(page.body as unknown as BodyInit, { status: page.status ?? 200, headers: { "content-type": page.type ?? "application/xml" } })
    : new Response("not here", { status: 404 });
  Object.defineProperty(res, "url", { value: url });
  return res;
}) as unknown as StepDeps["fetch"];

const labels = JSON.stringify({
  summary: "A dental group with treatment pages and a news section.",
  sections: [{ path: "/treatments/", label: "Treatments", purpose: "What they offer" }],
  themes: [{ name: "Implants", paths: ["/treatments/implants", "/news/a"] }],
  notable: [{ label: "Prices", path: "/pricing", why: "Their prices are public" }],
  worthKnowing: ["They post about once a fortnight."],
  newsPath: "/news/",
});
const words = JSON.stringify({ headline: "1 new post on a Leeds clinic", summary: "They are opening in Leeds.", topics: ["Leeds"] });

let db: FakeFirestore;
let deps: StepDeps;
const far = () => Date.now() + 10 * 60_000;

async function watched(context = ctx): Promise<Competitor> {
  const r = await monitorCompetitor(context, { website: "acme-dental.example", name: "Acme Dental" }, { db });
  if (!r.ok) throw new Error(r.error);
  const c = await advanceCompetitor(context, r.value.competitor.id, far(), deps);
  return c!;
}

beforeEach(() => {
  site();
  fetched = [];
  db = new FakeFirestore();
  deps = {
    db,
    fetch: fakeFetch,
    generate: vi.fn(async (prompt: string) => (prompt.includes("new posts") ? words : prompt.includes("changed since") ? words : labels)),
    grounded: vi.fn(async () => null),
  };
  vi.stubEnv("COMPETITORS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("setting up a competitor", () => {
  it("finds the sitemap through robots.txt, reads it, learns the site and keeps the news page's first read", async () => {
    const c = await watched();
    expect(c.status).toBe("watching");
    expect(c.problem).toBeNull();
    expect(c.sitemap).toMatchObject({ foundBy: "robots", pages: 8, truncated: false });
    expect(c.sitemap!.files).toEqual([`${W}/sitemap_index.xml`, `${W}/page-sitemap.xml`, `${W}/post-sitemap.xml.gz`]);
    // Never a sitemap off their site.
    expect(fetched).not.toContain("https://elsewhere.example/s.xml");
    expect(c.analysis?.ai).toBe(true);
    expect(c.analysis?.notable.map((n) => n.path)).toEqual(["/pricing"]);
    expect(c.analysis?.stats.sections.find((s) => s.path === "/news/")?.pages).toBe(4);
    expect(c.news).toMatchObject({ url: `${W}/news`, chosenBy: "analysis", feedUrl: `${W}/news/feed/` });
    expect(c.news?.baselineAt).toBeTruthy();
    // The first read is the baseline: three posts remembered, nothing reported.
    expect((await listPosts(ctx, c.id, { db })).map((p) => p.baseline)).toEqual([true, true, true]);
    expect(await listChanges(ctx, c.id, { db })).toEqual([]);
    expect(Date.parse(c.nextPostsCheckAt!) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    expect(Date.parse(c.nextSiteCheckAt!) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(nextStep(c, Date.now())).toBeNull();
    // Only one generation of pages is left.
    const chunks = await forTenant(ctx, db).competitorPages.find({ where: [["competitorId", "==", c.id]] });
    expect(new Set(chunks.map((ch) => ch.generation))).toEqual(new Set([c.sitemap!.generation]));
  });

  it("works with numbers only when there is no model, and asks a person when there's no sitemap or news page", async () => {
    deps.generate = async () => null;
    const c = await watched();
    expect(c.status).toBe("watching");
    expect(c.analysis?.ai).toBe(false);
    expect(c.analysis?.summary).toBe("");
    // The news page still comes from the biggest news-like section.
    expect(c.news?.chosenBy).toBe("path");

    web = new Map();
    const lost = await watched(other);
    expect(lost.status).toBe("needs_you");
    expect(lost.problem).toBe("no_sitemap");
    expect(deps.grounded).toHaveBeenCalled();
  });

  it("uses what search finds when the usual addresses have nothing", async () => {
    web.delete(`${W}/robots.txt`);
    web.delete(`${W}/sitemap_index.xml`);
    web.set(`${W}/hidden-map.xml`, { body: urlset(["/"], ["/news"], ["/news/a"], ["/news/b"], ["/news/c"]) });
    deps.grounded = vi.fn(async () => ({ text: `SITEMAP: ${W}/hidden-map.xml\nNEWS: NONE` }));
    const c = await watched();
    expect(c.sitemap?.foundBy).toBe("search");
    expect(c.status).toBe("watching");
  });

  it("never runs two callers on one competitor at once", async () => {
    const r = await monitorCompetitor(ctx, { website: "acme-dental.example", name: "Acme Dental" }, { db });
    if (!r.ok) throw new Error(r.error);
    await forTenant(ctx, db).competitors.update(r.value.competitor.id, { leaseUntil: new Date(Date.now() + 60_000).toISOString(), leaseId: "someone" });
    const c = await advanceCompetitor(ctx, r.value.competitor.id, far(), deps);
    expect(c?.status).toBe("finding");
    expect(fetched).toEqual([]);
  });
});

describe("watching", () => {
  async function due(c: Competitor, field: "nextPostsCheckAt" | "nextSiteCheckAt") {
    await forTenant(ctx, db).competitors.update(c.id, { [field]: new Date(Date.now() - 1000).toISOString() });
  }

  it("reports a new post once, read for its title and description", async () => {
    const c = await watched();
    web.set(`${W}/news/feed/`, { body: rss(["d", ""], ["c", "Opening hours"], ["b", "Whitening myths"], ["a", "Implants explained"]), type: "application/rss+xml" });
    await due(c, "nextPostsCheckAt");
    const after = await advanceCompetitor(ctx, c.id, far(), deps);
    const changes = await listChanges(ctx, c.id, { db });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "posts", headline: "1 new post on a Leeds clinic", seenAt: null });
    expect(changes[0]!.posts).toEqual([{ url: `${W}/news/d`, title: "A new clinic in Leeds", publishedAt: "2026-11-09" }]);
    expect(Date.parse(after!.nextPostsCheckAt!) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    // Next week, nothing new: nothing reported.
    await due(c, "nextPostsCheckAt");
    await advanceCompetitor(ctx, c.id, far(), deps);
    expect(await listChanges(ctx, c.id, { db })).toHaveLength(1);
  });

  it("reports a month's pages added and removed, and puts words to the site again", async () => {
    const c = await watched();
    web.set(`${W}/page-sitemap.xml`, { body: urlset(["/"], ["/treatments/implants"], ["/treatments/whitening"], ["/news"], ["/locations/leeds"], ["/locations/york"]) });
    await due(c, "nextSiteCheckAt");
    const calls = (deps.generate as ReturnType<typeof vi.fn>).mock.calls.length;
    const after = await advanceCompetitor(ctx, c.id, far(), deps);
    const [change] = await listChanges(ctx, c.id, { db });
    expect(change).toMatchObject({ kind: "site", added: { count: 2 }, removed: { count: 1 } });
    expect(change!.added.sections[0]).toEqual({ section: "/locations/", count: 2, sample: ["/locations/leeds", "/locations/york"] });
    expect(change!.removed.sections[0]!.sample).toEqual(["/pricing"]);
    expect(after!.sitemap!.pages).toBe(9);
    expect(after!.relabel).toBe(false);
    // Words for the change, then for the site's new shape.
    expect((deps.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 2);
  });

  it("reports no removals when a sitemap file couldn't be read, and keeps the old pages", async () => {
    const c = await watched();
    web.set(`${W}/post-sitemap.xml.gz`, { status: 500, body: "" });
    web.set(`${W}/page-sitemap.xml`, { body: urlset(["/"], ["/treatments/implants"], ["/treatments/whitening"], ["/pricing"], ["/news"], ["/careers"]) });
    await due(c, "nextSiteCheckAt");
    const after = await advanceCompetitor(ctx, c.id, far(), deps);
    const [change] = await listChanges(ctx, c.id, { db });
    expect(change).toMatchObject({ kind: "site", added: { count: 1 }, removed: { count: 0 } });
    expect(after!.sitemap!.pages).toBe(9);
  });

  it("tries again tomorrow when the whole sitemap can't be read, and asks a person after three", async () => {
    const c = await watched();
    for (const k of [...web.keys()]) if (k.includes("sitemap")) web.set(k, { status: 500, body: "" });
    let cur: Competitor | null = c;
    for (let i = 1; i <= 3; i += 1) {
      await due(cur!, "nextSiteCheckAt");
      cur = await advanceCompetitor(ctx, c.id, far(), deps);
      expect(cur!.failures).toBe(i);
    }
    expect(cur!.status).toBe("needs_you");
    expect(cur!.problem).toBe("read_failed");
    expect(await listChanges(ctx, c.id, { db })).toEqual([]);
  });
});

describe("two brands watching the same site", () => {
  it("keep their own posts and pages", async () => {
    const a = await watched(ctx);
    const b = await watched(other);
    expect((await listPosts(ctx, a.id, { db })).length).toBe(3);
    expect((await listPosts(other, b.id, { db })).length).toBe(3);
    expect(await forTenant(ctx, db).competitors.getById(b.id)).toBeNull();
  });
});

describe("a site whose bot screen turns us away", () => {
  const B = "https://blocked.example";
  const OK = "URL_RETRIEVAL_STATUS_SUCCESS";
  // SiteGround's challenge, for every address we ask ourselves.
  const challenge: Page = { status: 202, body: `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></head></html>`, type: "text/html" };
  let google: Map<string, string>;
  let titles: Map<string, string>;
  let readWithGoogle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const p of ["/robots.txt", "/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/wp-sitemap.xml", "/blog", "/blog/feed/"]) web.set(`${B}${p}`, challenge);
    // What Google can read: like otterly.ai, their main sitemap isn't one of them, their blog's are.
    google = new Map([
      [`${B}/robots.txt`, "User-agent: *\nAllow: /\nDisallow: /private/\nSitemap: https://www.blocked.example/sitemap.xml"],
      [`${B}/blog/sitemap_index.xml`, `KIND: index\nhttp://blocked.example/blog/category-sitemap.xml\nhttp://blocked.example/blog/post-sitemap.xml\nhttps://elsewhere.example/blog/post-sitemap.xml`],
      [
        `${B}/blog/post-sitemap.xml`,
        [
          "KIND: urlset",
          `${B}/blog/\t2026-11-13`,
          `${B}/blog/one\t2026-11-12T10:00:00+00:00`,
          `${B}/blog/two\t2026-11-10`,
          `${B}/blog/three\t2026-11-01`,
          `${B}/blog/2026/11/13\t2026-11-13`,
          "https://elsewhere.example/blog/four\t2026-11-11",
        ].join("\n"),
      ],
    ]);
    titles = new Map();
    readWithGoogle = vi.fn(async (prompt: string) => {
      if (prompt.includes("Read each of these pages")) {
        const asked = [...prompt.matchAll(/^https:\/\/\S+$/gm)].map((m) => m[0]);
        const lines = asked.filter((u) => titles.has(u)).map((u) => `${u}\t${titles.get(u)}\t2026-11-16`);
        lines.push(`${B}/blog/made-up\tA post nobody asked about\t2026-11-16`);
        return { text: lines.join("\n"), retrieved: asked.map((url) => ({ url, status: titles.has(url) ? OK : "URL_RETRIEVAL_STATUS_ERROR" })), model: "m" };
      }
      const url = /Read (\S+) with the URL context tool/.exec(prompt)?.[1] ?? "";
      const text = google.get(url);
      return text ? { text, retrieved: [{ url, status: OK }], model: "m" } : { text: "CANNOT_READ", retrieved: [{ url, status: "URL_RETRIEVAL_STATUS_ERROR" }], model: "m" };
    });
    deps.readWithGoogle = readWithGoogle as unknown as StepDeps["readWithGoogle"];
    deps.grounded = vi.fn(async () => ({ text: `SITEMAP: NONE\nNEWS: ${B}/blog` }));
  });
  afterEach(() => vi.restoreAllMocks());

  async function monitorBlocked(): Promise<Competitor> {
    const r = await monitorCompetitor(ctx, { website: "blocked.example", name: "Blocked" }, { db });
    if (!r.ok) throw new Error(r.error);
    return (await advanceCompetitor(ctx, r.value.competitor.id, far(), deps))!;
  }

  it("says so plainly when Google may not read for us, without a web search", async () => {
    const c = await monitorBlocked();
    expect(c).toMatchObject({ status: "needs_you", problem: "turned_away", news: null, sitemap: null });
    expect(deps.grounded).not.toHaveBeenCalled();
    expect(readWithGoogle).not.toHaveBeenCalled();
  });

  it("reads their news through Google from their posts' sitemap file: news only, never links from a web page", async () => {
    vi.stubEnv("COMPETITORS_GOOGLE_READER_ENABLED", "true");
    const c = await monitorBlocked();
    expect(c).toMatchObject({ status: "watching", reader: "google", problem: null, sitemap: null, nextSiteCheckAt: null, googleFind: null });
    expect(c.news).toMatchObject({ url: `${B}/blog`, sitemapUrl: `${B}/blog/post-sitemap.xml` });
    expect(Date.parse(c.nextPostsCheckAt!) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    // The baseline: its posts, not the blog page itself, a date archive or another site's page.
    const posts = await listPosts(ctx, c.id, { db });
    expect(posts.map((p) => p.url).sort()).toEqual([`${B}/blog/one`, `${B}/blog/three`, `${B}/blog/two`]);
    expect(posts.every((p) => p.baseline)).toBe(true);
    expect(await listChanges(ctx, c.id, { db })).toEqual([]);
    const asked = readWithGoogle.mock.calls.map(([p]) => String(p));
    // Their robots.txt first; never their blog page (a model lists made-up links from a page) or their categories.
    expect(asked[0]).toContain(`Read ${B}/robots.txt`);
    expect(asked.some((p) => p.includes(`Read ${B}/blog with`))).toBe(false);
    expect(asked.some((p) => p.includes("category-sitemap"))).toBe(false);

    // A week on, one new post: found through Google, titled from the post itself.
    google.set(`${B}/blog/post-sitemap.xml`, `KIND: urlset\n${B}/blog/four-new\t2026-11-17\n${B}/blog/one\t2026-11-12\n${B}/blog/ancient\t2024-01-01`);
    titles.set(`${B}/blog/four-new`, "Four new things about whitening");
    await forTenant(ctx, db).competitors.update(c.id, { nextPostsCheckAt: new Date(Date.now() - 1000).toISOString() });
    const after = await advanceCompetitor(ctx, c.id, far(), deps);
    expect(after).toMatchObject({ status: "watching", googlePending: null, problem: null });
    const changes = await listChanges(ctx, c.id, { db });
    expect(changes).toHaveLength(1);
    // An old post that wasn't in the baseline isn't news, and a made-up address is never kept.
    expect(changes[0]!.posts).toEqual([{ url: `${B}/blog/four-new`, title: "Four new things about whitening", publishedAt: "2026-11-17" }]);
    expect((await listPosts(ctx, c.id, { db })).map((p) => p.url)).not.toContain(`${B}/blog/made-up`);
  });

  it("asks a person when Google can't read their sitemaps either", async () => {
    vi.stubEnv("COMPETITORS_GOOGLE_READER_ENABLED", "true");
    google = new Map();
    const c = await monitorBlocked();
    expect(c).toMatchObject({ status: "needs_you", problem: "turned_away", reader: "google", googleFind: null });
  });

  it("starts again a competitor an older version left watching nothing", async () => {
    const r = await monitorCompetitor(ctx, { website: "acme-dental.example", name: "Acme Dental" }, { db });
    if (!r.ok) throw new Error(r.error);
    await forTenant(ctx, db).competitors.update(r.value.competitor.id, { status: "watching", stage: null, problem: "no_news_page", sitemap: null, news: null });
    const c = await advanceCompetitor(ctx, r.value.competitor.id, far(), deps);
    expect(c).toMatchObject({ status: "watching", problem: null });
    expect(c!.sitemap?.pages).toBe(8);
  });

  it("keeps the date on each card of a news page with no feed, and its place for one with none", async () => {
    web.delete(`${W}/news/feed/`);
    web.set(`${W}/news`, {
      body: `<html><body><a href="/news/c"><p>2 Nov, 2026</p><h3>Opening hours</h3></a><a href="/news/b"><h3>Whitening myths</h3></a><a href="/news/a"><p>1 Oct, 2026</p><h3>Implants</h3></a></body></html>`,
      type: "text/html",
    });
    const c = await watched();
    const posts = new Map((await listPosts(ctx, c.id, { db })).map((p) => [p.url.split("/").pop(), p]));
    expect(posts.get("c")).toMatchObject({ publishedAt: "2026-11-02", rank: 0, baseline: true });
    expect(posts.get("b")).toMatchObject({ publishedAt: null, rank: 1 });
    expect(posts.get("a")).toMatchObject({ publishedAt: "2026-10-01", rank: 2 });
  });

  it("never leaves a competitor watching when it has no sitemap and a news page that lists nothing", async () => {
    web = new Map<string, Page>([
      [`${W}/robots.txt`, { body: "User-agent: *\nAllow: /\n", type: "text/plain" }],
      [`${W}/news`, { body: "<html><body><p>Coming soon.</p></body></html>", type: "text/html" }],
    ]);
    deps.grounded = vi.fn(async () => ({ text: `SITEMAP: NONE\nNEWS: ${W}/news` }));
    const c = await watched();
    expect(c).toMatchObject({ status: "needs_you", problem: "no_sitemap", news: null });
  });
});
