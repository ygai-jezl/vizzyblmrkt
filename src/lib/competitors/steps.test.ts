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
