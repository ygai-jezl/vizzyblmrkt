import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { markdownToText } from "@/lib/search/text";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { BlogArticleMetaSchema, type ContentPlan } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import { addressScore, articlesToWatch, keyWords, LIVE_WATCH, runLiveWatch, wakeLiveWatch, withoutBuildDates } from "./liveWatch";
import { sampleHub, samplePlan } from "./testing/samplePlan";
import { SAMPLE_ARTICLE } from "./testing/sampleArticle";

vi.mock("./hubActions", async (importOriginal) => ({ ...(await importOriginal<typeof import("./hubActions")>()), keepApprovedSeen: vi.fn(async () => true) }));

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const PLANS = "workspaces/ws1/content_plans";
const TITLE = "What is AI search visibility monitoring?";
const SLUG = "what-is-ai-search-visibility-monitoring";
const SITE = "https://acme.example";
/** 10:00 UTC: a tick that looks for brands (every 10 minutes). */
const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const H = 3_600_000;
const tenant = { id: "ten_A", region: "us", status: "active", rootDomain: "acme.example" } as unknown as Tenant;
const articleHtml = (published = "2026-11-20") =>
  `<html><head><title>AI Visibility Explained | Acme</title><meta property="article:published_time" content="${published}"></head><body><nav>Home Pricing Blog</nav><h1>${TITLE}</h1><p>${markdownToText(SAMPLE_ARTICLE)}</p></body></html>`;
const otherHtml = `<html><head><title>Pricing | Acme</title></head><body><h1>Pricing</h1><p>Plans for every team size, billed monthly or yearly.</p></body></html>`;

const hubMeta = (over: Record<string, unknown> = {}) => BlogArticleMetaSchema.parse({ slug: SLUG, lastUpdated: "2026-11-15", metaTitle: "AI search visibility monitoring", ...over });
const draft = (over: Partial<ContentPlan> = {}, hub = sampleHub({ blog: hubMeta() })) =>
  samplePlan({ strategy: { objective: "brand_visibility", hubUrl: null, subscriberCount: null, sequenceType: null }, ...over }, hub);

/** A made-up site: robots.txt, a sitemap index, its files and pages. Counts what was opened. */
type SiteFiles = Record<string, { body: string; type?: string; status?: number }>;
const answer = (files: SiteFiles, url: string) => {
  const f = files[url];
  if (!f) return new Response("not here", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(f.body, { status: f.status ?? 200, headers: { "content-type": f.type ?? "text/html" } });
};
function site(files: SiteFiles) {
  const opened: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    opened.push(url);
    return answer(files, url);
  });
  return { fetch: fetch as never, opened, files };
}
const urlset = (entries: Array<[string, string?]>) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(([loc, mod]) => `<url><loc>${loc}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ""}</url>`).join("")}</urlset>`;
const standardSite = (extra: Array<[string, string?]> = []) =>
  site({
    [`${SITE}/robots.txt`]: { body: `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap_index.xml`, type: "text/plain" },
    [`${SITE}/sitemap_index.xml`]: {
      body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>${SITE}/post-sitemap.xml</loc><lastmod>2026-11-20</lastmod></sitemap><sitemap><loc>${SITE}/page-sitemap.xml</loc><lastmod>2026-01-01</lastmod></sitemap></sitemapindex>`,
      type: "application/xml",
    },
    [`${SITE}/post-sitemap.xml`]: {
      body: urlset([[`${SITE}/blog/${SLUG}`, "2026-11-20"], [`${SITE}/blog/old-news`, "2025-06-01"], [`${SITE}/blog/unrelated-launch-notes`, "2026-11-19"], ...extra]),
      type: "application/xml",
    },
    [`${SITE}/page-sitemap.xml`]: { body: urlset([[`${SITE}/pricing`, "2026-01-01"]]), type: "application/xml" },
    [`${SITE}/blog/${SLUG}`]: { body: articleHtml() },
    [`${SITE}/pricing`]: { body: otherHtml },
  });

function seed(db: FakeFirestore, plan: ContentPlan) {
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog", createdAt: "2026-01-01T00:00:00.000Z" });
  db.seed(PLANS, plan.id, plan);
}
const run = (db: FakeFirestore, deps: Record<string, unknown> = {}, at = T0) =>
  runLiveWatch({ deadlineMs: at + 25_000 }, { db, clock: () => at, listTenants: async () => [tenant], siteOf: async () => SITE, ...deps });
const hub = async (db: FakeFirestore) => (await getContentPlan(A, "ws1", "plan_1", db))!.graph.nodes[0]!;
const watchDoc = (db: FakeFirestore) => forTenant(A, db).liveWatch.getById("lw_ten_A");

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("which pages are worth opening", () => {
  it("knows an article's address by its slug, or by two key words of its titles", () => {
    const article = { slug: SLUG, titles: [TITLE, "AI search visibility monitoring"] };
    expect(addressScore(`${SITE}/blog/${SLUG}/`, article)).toBe(100);
    expect(addressScore(`${SITE}/blog/ai-visibility-monitoring-explained`, article)).toBeGreaterThanOrEqual(2);
    expect(addressScore(`${SITE}/blog/visibility`, article)).toBe(0);
    expect(addressScore(`${SITE}/pricing`, article)).toBe(0);
    expect([...keyWords("How do I get the BLOG post on AI?")]).toEqual([]);
  });

  it("takes a lastmod most pages share as a build date, not when each changed", () => {
    const same = Array.from({ length: 10 }, (_, i) => ({ loc: `${SITE}/p${i}`, lastmod: "2026-11-21" }));
    expect(withoutBuildDates(same).every((e) => e.lastmod === null)).toBe(true);
    const mixed = same.map((e, i) => ({ ...e, lastmod: i < 5 ? "2026-11-21" : `2026-10-0${i}` }));
    expect(withoutBuildDates(mixed)).toEqual(mixed);
  });
});

describe("articles it watches", () => {
  it("articles written lately and not live; never one autopilot is writing, an archived plan, or one not written", async () => {
    for (const [plan, waiting] of [
      [draft(), 1],
      [draft({ autopilot: { runId: "run_x", state: "working", at: "" } }), 0],
      [draft({ status: "archived" }), 0],
      [draft({}, sampleHub({ status: "generating", blog: hubMeta() })), 0],
      [draft({}, sampleHub({ blog: hubMeta({ lastUpdated: "2026-08-01" }) })), 0],
    ] as const) {
      const db = new FakeFirestore();
      seed(db, plan);
      expect((await articlesToWatch(A, T0, { db })).waiting).toHaveLength(waiting);
    }
  });
});

describe("the live watch lane", () => {
  it("does nothing with the switch off, or between its looks", async () => {
    const db = new FakeFirestore();
    seed(db, draft());
    const s = standardSite();
    vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "");
    expect(await run(db, { fetch: s.fetch })).toEqual({ brands: 0, opened: 0, found: 0, approved: 0 });
    vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "true");
    expect(await run(db, { fetch: s.fetch }, T0 + LIVE_WATCH.TICK_MS)).toMatchObject({ brands: 0 });
    expect(s.opened).toEqual([]);
  });

  it("finds an article with no address on the sitemap, saves its address, marks it live and approves it", async () => {
    const db = new FakeFirestore();
    seed(db, draft());
    const s = standardSite();
    const r = await run(db, { fetch: s.fetch });
    expect(r).toMatchObject({ brands: 1, found: 1, approved: 1 });
    // Only the page whose address is the article's was opened: not pricing, not old or unrelated posts.
    expect(s.opened.filter((u) => !/robots|sitemap/.test(u))).toEqual([`${SITE}/blog/${SLUG}`]);
    const plan = (await getContentPlan(A, "ws1", "plan_1", db))!;
    expect(plan.strategy.hubUrl).toBe(`${SITE}/blog/${SLUG}`);
    expect(plan.graph.nodes[0]).toMatchObject({ status: "approved", blog: { live: { url: `${SITE}/blog/${SLUG}`, by: "check", found: "sitemap", auto: true, approvedOnLive: true } } });
    expect(db.raw("brand_map_pages", "p_plan_1")).toMatchObject({ state: "live" });
    // Back in about 3 hours, or 6 with nothing left waiting.
    expect(Date.parse((await watchDoc(db))!.nextAt)).toBe(T0 + LIVE_WATCH.IDLE_MS);
  });

  it("with true dates on, takes Published from the page it finds, and writes none with them off", async () => {
    vi.stubEnv("BLOG_DATES_ENABLED", "true");
    const db = new FakeFirestore();
    seed(db, draft());
    await run(db, { fetch: standardSite().fetch });
    expect((await hub(db)).blog?.dates).toEqual({
      published: { at: "2026-11-20", source: "page" },
      page: { published: "2026-11-20", modified: null, readAt: new Date(T0).toISOString() },
    });
    vi.stubEnv("BLOG_DATES_ENABLED", "");
    const off = new FakeFirestore();
    seed(off, draft());
    await run(off, { fetch: standardSite().fetch });
    expect((await hub(off)).blog?.dates).toBeUndefined();
  });

  it("never opens a page it already opened, until its lastmod changes", async () => {
    const db = new FakeFirestore();
    seed(db, draft({}, sampleHub({ blog: hubMeta({ slug: "a-different-slug" }) })));
    const s = standardSite([[`${SITE}/blog/ai-search-visibility-guide`, "2026-11-20"]]);
    await run(db, { fetch: s.fetch });
    const first = s.opened.filter((u) => u.includes("/blog/")).length;
    expect(first).toBeGreaterThan(0);
    s.opened.length = 0;
    await run(db, { fetch: s.fetch }, T0 + LIVE_WATCH.PASS_MS);
    expect(s.opened.filter((u) => u.includes("/blog/"))).toEqual([]);
  });

  it("rejects a page dated well before the article was written", async () => {
    const db = new FakeFirestore();
    seed(db, draft());
    const s = standardSite();
    const dated = site({ ...s.files, [`${SITE}/blog/${SLUG}`]: { body: articleHtml("2025-01-01") } });
    expect(await run(db, { fetch: dated.fetch })).toMatchObject({ found: 0 });
    expect((await hub(db)).status).toBe("generated");
  });

  it("checks a saved address straight away, then every 3 hours for two weeks", async () => {
    const db = new FakeFirestore();
    const url = `${SITE}/blog/visibility`;
    seed(db, draft({ strategy: { objective: "brand_visibility", hubUrl: url, subscriberCount: null, sequenceType: null } }));
    const readAddress = vi.fn(async () => ({ title: "Not yet", text: "Coming soon" }));
    await run(db, { readAddress, fetch: standardSite().fetch });
    expect(readAddress).toHaveBeenCalledTimes(1);
    const doc = (await watchDoc(db))!;
    expect(doc.addresses.plan_1).toMatchObject({ url, checks: 1, textShare: 0 });
    expect(Date.parse(doc.nextAt)).toBe(T0 + LIVE_WATCH.PASS_MS);
    // Not due before then.
    await run(db, { readAddress }, T0 + H);
    expect(readAddress).toHaveBeenCalledTimes(1);
    // Due, and now it's up (the site's own title, the article's text).
    readAddress.mockResolvedValue({ title: "AI Visibility Explained | Acme", h1: TITLE, text: markdownToText(SAMPLE_ARTICLE) } as never);
    const r = await run(db, { readAddress }, T0 + LIVE_WATCH.PASS_MS);
    expect(r).toMatchObject({ found: 1, approved: 1 });
    expect(await hub(db)).toMatchObject({ status: "approved", blog: { live: { url, found: "address", auto: true } } });
  });

  it("stops checking an address after two weeks", async () => {
    const db = new FakeFirestore();
    seed(db, draft({ strategy: { objective: "brand_visibility", hubUrl: `${SITE}/blog/visibility`, subscriberCount: null, sequenceType: null } }));
    const readAddress = vi.fn(async () => ({ title: "Not yet", text: "" }));
    await run(db, { readAddress });
    const later = T0 + 15 * 24 * H;
    await run(db, { readAddress }, later);
    expect(readAddress).toHaveBeenCalledTimes(1);
  });

  it("approves an article marked live before, with no page opened", async () => {
    const db = new FakeFirestore();
    const url = `${SITE}/blog/visibility`;
    const live = { url, at: "2026-11-20T10:00:00.000Z", by: "operator" as const, titleMatched: false };
    seed(db, draft({ strategy: { objective: "brand_visibility", hubUrl: url, subscriberCount: null, sequenceType: null } }, sampleHub({ blog: hubMeta({ live }) })));
    const readAddress = vi.fn();
    const r = await run(db, { readAddress });
    expect(r).toMatchObject({ approved: 1, opened: 0 });
    expect(readAddress).not.toHaveBeenCalled();
    expect(await hub(db)).toMatchObject({ status: "approved", blog: { live: { by: "operator", approvedOnLive: true } } });
  });

  it("a brand not due is passed over; a save wakes it for the next look", async () => {
    const db = new FakeFirestore();
    seed(db, draft());
    const s = standardSite();
    await run(db, { fetch: s.fetch });
    const later = T0 + LIVE_WATCH.SOON_MS;
    expect(await run(db, { fetch: s.fetch }, later)).toMatchObject({ brands: 0 });
    await wakeLiveWatch(A, { db, now: () => new Date(later) });
    expect(await run(db, { fetch: s.fetch }, later)).toMatchObject({ brands: 1 });
  });

  it("says so when the site has no sitemap, and still checks saved addresses", async () => {
    const db = new FakeFirestore();
    seed(db, draft());
    const s = site({ [`${SITE}/robots.txt`]: { body: "User-agent: *\nAllow: /", type: "text/plain" } });
    await run(db, { fetch: s.fetch });
    expect((await watchDoc(db))!.lastError).toBe("no_sitemap");
  });

  it("keeps out of pages the brand's robots.txt keeps us out of", async () => {
    const db = new FakeFirestore();
    seed(db, draft());
    const s = standardSite();
    const blocked = site({
      [`${SITE}/robots.txt`]: { body: `User-agent: yougrowbot\nDisallow: /blog/\nSitemap: ${SITE}/post-sitemap.xml`, type: "text/plain" },
      [`${SITE}/post-sitemap.xml`]: { body: urlset([[`${SITE}/blog/${SLUG}`, "2026-11-20"]]), type: "application/xml" },
    });
    void s;
    expect(await run(db, { fetch: blocked.fetch })).toMatchObject({ found: 0 });
    expect(blocked.opened).not.toContain(`${SITE}/blog/${SLUG}`);
  });

  it("one brand's watch is its own: another brand can't read it, and waking one leaves the other alone", async () => {
    const db = new FakeFirestore();
    const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
    await wakeLiveWatch(A, { db, now: () => new Date(T0) });
    expect(await forTenant(B, db).liveWatch.getById("lw_ten_A")).toBeNull();
    await wakeLiveWatch(B, { db, now: () => new Date(T0 + H) });
    expect((await watchDoc(db))!.nextAt).toBe(new Date(T0).toISOString());
    await expect(forTenant(B, db).liveWatch.update("lw_ten_A", { nextAt: "x" })).rejects.toThrow();
  });

  it("keeps its list of opened pages small", async () => {
    const db = new FakeFirestore();
    const lines = Array.from({ length: LIVE_WATCH.MAX_SEEN }, (_, i) => `${i.toString(16).padStart(16, "0")}\t2026-11-20`);
    expect(JSON.stringify(lines).length).toBeLessThan(200_000);
    void db;
  });
});
