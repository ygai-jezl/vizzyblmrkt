import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { forTenant } from "@/lib/tenant";
import { getContentPlan, updateContentPlan } from "@/lib/tenant/workspaceContent";
import { BlogArticleMetaSchema, BlogBriefSchema, BlogSourceSchema } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import { articlePageKey, bareHost, freshnessWatchId, outboundLinks, runFreshness, sweepBrand } from "./freshnessWatch";
import { setArticleLive } from "./live";
import { sampleHub, samplePlan } from "./testing/samplePlan";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const PLANS = "workspaces/ws1/content_plans";
const NOW = new Date("2026-11-24T12:00:00.000Z");
const URL_ = "https://acme.example/blog/visibility";
const BODY =
  "# What is AI search visibility monitoring?\n\n*Last updated: 2026-10-10*\n\nIn 2023, 38% of buyers asked an AI assistant first. See [the survey](https://research.example.org/2023) and [our pricing](https://acme.example/pricing) and [an old report](https://gone.example.net/report).";

function world(over: { refreshClock?: Tenant["refreshClock"] } = {}, published = "2026-10-20") {
  const db = new FakeFirestore();
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog", createdAt: "2026-01-01T00:00:00.000Z" });
  const brief = BlogBriefSchema.parse({ subjectId: "sub_1", sources: [BlogSourceSchema.parse({ url: "https://research.example.org/2023", year: 2023 })] });
  const blog = BlogArticleMetaSchema.parse({});
  const hub = sampleHub({
    body: BODY,
    status: "approved",
    blog: { ...blog, live: { url: URL_, at: "2026-10-21T08:00:00.000Z", by: "check", titleMatched: true }, dates: { published: { at: published, source: "page" } } },
  });
  db.seed(PLANS, "plan_1", samplePlan({ blog: brief, strategy: { objective: "brand_visibility", hubUrl: URL_ } }, hub));
  const tenant = { id: "ten_A", region: "us", status: "active", ...over } as unknown as Tenant;
  return { db, tenant };
}

const checked: string[] = [];
const deps = (db: FakeFirestore, now = NOW, openOnSubject = 3) => ({
  db,
  now: () => now,
  rand: () => 0,
  losingPages: async () => new Map([["acme.example/blog/visibility", "Search Console: 120 clicks, down from 260."]]),
  reachPages: async () => new Map([["acme.example/blog/visibility", "Search Console: position 12 on average."]]),
  openQuestions: async () => new Map([["sub_1", openOnSubject]]),
  checkLink: async (url: string) => {
    checked.push(url);
    return url.includes("gone.example") ? ("dead" as const) : ("ok" as const);
  },
});
const hubOf = async (db: FakeFirestore) => (await getContentPlan(A, "ws1", "plan_1", db))!.graph.nodes[0]!.blog!;

beforeEach(() => {
  checked.length = 0;
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BLOG_DATES_ENABLED", "true");
  vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the freshness watch", () => {
  it("keys pages the way Search Console does, and finds an article's outbound links", () => {
    expect(bareHost("sc-domain:Acme.example")).toBe("acme.example");
    expect(bareHost("https://www.acme.example/")).toBe("acme.example");
    expect(articlePageKey("https://www.acme.example/blog/visibility?utm=x#top")).toBe("acme.example/blog/visibility");
    expect(outboundLinks(BODY, "acme.example")).toEqual(["https://research.example.org/2023", "https://gone.example.net/report"]);
  });

  it("gives a live article its clock and works out its state from every signal, with no AI", async () => {
    const { db, tenant } = world();
    const doc = await sweepBrand(A, tenant, deps(db));
    const f = (await hubOf(db)).freshness!;
    expect(f).toMatchObject({ clockDays: 20, arm: "test", state: "due", deadLinks: ["https://gone.example.net/report"], linksCheckedAt: NOW.toISOString() });
    expect(f.reasons.map((r) => r.kind)).toEqual(["age", "losing_clicks", "dead_link", "old_figure", "within_reach", "old_source"]);
    expect(f.openAtStart).toBe(3);
    expect(f.events).toEqual([{ at: NOW.toISOString(), kind: "due", clockDays: 20 }]);
    expect(doc).toMatchObject({ counts: { fresh: 0, soon: 0, due: 1 }, byClock: { "20": 1, "30": 0, "45": 0 }, pages: [{ key: "acme.example/blog/visibility", planId: "plan_1", workspaceId: "ws1" }] });
    expect(doc.due[0]).toMatchObject({ planId: "plan_1", title: "What is AI search visibility monitoring?", state: "due", clockDays: 20, subjectId: "sub_1" });
    expect(checked).toEqual(["https://research.example.org/2023", "https://gone.example.net/report"]);
  });

  it("leaves old figures and old sources out for an article's first 14 days live", async () => {
    // Live, 26 Nov 2026: an autopilot article went due for a 2024 figure three days after it went live.
    const { db, tenant } = world({}, "2026-11-20");
    await sweepBrand(A, tenant, deps(db));
    const reasons = (await hubOf(db)).freshness!.reasons.map((r) => r.kind);
    expect(reasons).not.toContain("old_figure");
    expect(reasons).not.toContain("old_source");
    expect(reasons).toContain("dead_link");
    // Past the 14 days they count again.
    await sweepBrand(A, tenant, deps(db, new Date("2026-12-05T12:00:00.000Z")));
    expect((await hubOf(db)).freshness!.reasons.map((r) => r.kind)).toEqual(expect.arrayContaining(["old_figure", "old_source"]));
  });

  it("checks links once a week, records becoming due once, and a canvas save keeps it all", async () => {
    const { db, tenant } = world();
    await sweepBrand(A, tenant, deps(db));
    await sweepBrand(A, tenant, deps(db, new Date("2026-11-25T12:00:00.000Z")));
    expect(checked).toHaveLength(2);
    const f = (await hubOf(db)).freshness!;
    expect(f.events).toHaveLength(1);
    expect(f.clockDays).toBe(20);
    await updateContentPlan(A, "ws1", "plan_1", { graph: samplePlan({}, sampleHub({ body: "edited", status: "approved" })).graph }, db);
    expect((await hubOf(db)).freshness).toMatchObject({ clockDays: 20, state: "due" });
  });

  it("counts only questions opened on its subject since its clock started, afresh after a check", async () => {
    const { db, tenant } = world();
    const kinds = async () => (await hubOf(db)).freshness!.reasons.filter((r) => r.kind === "new_questions").map((r) => r.detail);
    await sweepBrand(A, tenant, deps(db, NOW, 30));
    expect(await kinds()).toEqual([]);
    await sweepBrand(A, tenant, deps(db, new Date("2026-11-25T12:00:00.000Z"), 31));
    expect(await kinds()).toEqual([]);
    await sweepBrand(A, tenant, deps(db, new Date("2026-11-26T12:00:00.000Z"), 33));
    expect(await kinds()).toEqual(["3 new questions on its subject that no live page answers"]);
    expect((await hubOf(db)).freshness!.openAtStart).toBe(30);
    // A check starts the clock again: the next look takes today's count as its start.
    const { markChecked } = await import("./refreshAdmin");
    expect((await markChecked({ ...A, source: "idtoken", role: "admin" }, { workspaceId: "ws1", planId: "plan_1", nodeId: "hub" }, { db, now: () => new Date("2026-11-26T13:00:00.000Z") })).ok).toBe(true);
    expect((await hubOf(db)).freshness!.openAtStart).toBeNull();
    await sweepBrand(A, tenant, deps(db, new Date("2026-11-27T12:00:00.000Z"), 33));
    expect(await kinds()).toEqual([]);
    expect((await hubOf(db)).freshness!.openAtStart).toBe(33);
  });

  it("reads a refreshed article's page again until it shows the new Updated (BLOG_REFRESH_ENABLED)", async () => {
    vi.stubEnv("BLOG_REFRESH_ENABLED", "true");
    const { db, tenant } = world();
    const plan = (await getContentPlan(A, "ws1", "plan_1", db))!;
    const hub = plan.graph.nodes[0]!;
    hub.blog = { ...hub.blog!, dates: { ...hub.blog!.dates!, updated: { at: "2026-11-23T10:00:00.000Z", source: "change" } } };
    db.seed(PLANS, "plan_1", plan);
    let page: { published: string | null; modified: string | null } = { published: "2026-10-20", modified: null };
    const d = { ...deps(db), pageDates: async () => page };
    await sweepBrand(A, tenant, d);
    expect((await hubOf(db)).freshness!.reasons.map((r) => r.kind)).toContain("page_behind");
    expect((await hubOf(db)).dates!.updated).toEqual({ at: "2026-11-23T10:00:00.000Z", source: "change" });
    // Republished: the page's own date takes over, and the reason goes.
    page = { published: "2026-10-20", modified: "2026-11-23T16:00:00Z" };
    await sweepBrand(A, tenant, d);
    expect((await hubOf(db)).dates!.updated).toEqual({ at: "2026-11-23T16:00:00.000Z", source: "page" });
    expect((await hubOf(db)).freshness!.reasons.map((r) => r.kind)).not.toContain("page_behind");
  });

  it("uses a clock the brand fixed, and Not live takes the clock away", async () => {
    const { db, tenant } = world({ refreshClock: 45 });
    await sweepBrand(A, tenant, deps(db));
    expect((await hubOf(db)).freshness).toMatchObject({ clockDays: 45, arm: "fixed" });
    const plan = (await getContentPlan(A, "ws1", "plan_1", db))!;
    await setArticleLive({ ...A, source: "idtoken", role: "admin" }, { workspaceId: "ws1", plan, nodeId: "hub", action: "clear" }, { db, now: () => NOW });
    expect((await hubOf(db)).freshness).toBeUndefined();
  });

  it("looks at a brand once a day, and not at all with its switch off", async () => {
    const { db, tenant } = world();
    const run = (now: Date) => runFreshness({ deadlineMs: Date.now() + 60_000 }, { ...deps(db, now), listTenants: async () => [tenant] });
    expect(await run(NOW)).toMatchObject({ brands: 1, articles: 1, due: 1 });
    expect(await run(new Date("2026-11-24T20:00:00.000Z"))).toMatchObject({ brands: 0 });
    expect(await run(new Date("2026-11-25T12:30:00.000Z"))).toMatchObject({ brands: 1 });
    expect((await forTenant(A, db).freshnessWatch.getById(freshnessWatchId("ten_A")))?.linksToday).toBe(0);
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "");
    expect(await run(new Date("2026-11-27T12:30:00.000Z"))).toEqual({ brands: 0, articles: 0, due: 0 });
  });
});

describe("an erase while a look runs", () => {
  const SECOND = "https://acme.example/blog/answer-engines";
  const keys = ["acme.example/blog/visibility", "acme.example/blog/answer-engines"];
  const scKinds = (reasons: readonly { kind: string }[]) => reasons.map((r) => r.kind).filter((k) => k === "losing_clicks" || k === "within_reach");

  it("writes none of Search Console's figures after it, takes them off the list, keeps the next look due now, and the next look puts back what is still read", async () => {
    const { db, tenant } = world();
    // A second live article, made later, so the look reaches it first. It has no outbound links.
    const hub = sampleHub({
      body: "# What are answer engines?\n\nThey answer a question in place of a list of links.",
      status: "approved",
      blog: { ...BlogArticleMetaSchema.parse({}), live: { url: SECOND, at: "2026-10-22T08:00:00.000Z", by: "check", titleMatched: true }, dates: { published: { at: "2026-10-21", source: "page" } } },
    });
    db.seed(PLANS, "plan_2", samplePlan({ id: "plan_2", name: "Answer engines", createdAt: "2026-10-08T08:00:00.000Z", strategy: { objective: "brand_visibility", hubUrl: SECOND } }, hub));
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    let erase: (() => Promise<unknown>) | null = null;
    const run = (now: Date) =>
      sweepBrand(A, tenant, {
        ...deps(db, now),
        losingPages: async () => new Map(keys.map((k) => [k, "Search Console: 120 clicks, down from 260."])),
        reachPages: async () => new Map(keys.map((k) => [k, "Search Console: position 12 on average."])),
        // The erase lands while the look checks the first article's links: after it wrote the second.
        checkLink: async () => {
          const go = erase;
          erase = null;
          if (go) await go();
          return "ok" as const;
        },
      });
    const reasonsOf = async (planId: string) => (await getContentPlan(A, "ws1", planId, db))!.graph.nodes[0]!.blog!.freshness!.reasons;
    const watchDoc = async () => (await forTenant(A, db).freshnessWatch.getById(freshnessWatchId("ten_A")))!;

    await run(NOW);
    expect(scKinds(await reasonsOf("plan_1"))).toEqual(["losing_clicks", "within_reach"]);
    expect(scKinds(await reasonsOf("plan_2"))).toEqual(["losing_clicks", "within_reach"]);

    const { clearSearchConsoleReasons } = await import("./freshnessErase");
    erase = () => clearSearchConsoleReasons(A, { db, now: later });
    const doc = await run(later);
    expect(erase).toBeNull();
    // Neither article keeps the figures: the second, written before the erase, lost them to it; the
    // first, written after, never got them.
    expect(scKinds(await reasonsOf("plan_1"))).toEqual([]);
    expect(scKinds(await reasonsOf("plan_2"))).toEqual([]);
    const stored = await watchDoc();
    expect(stored.due.map((d) => d.planId).sort()).toEqual(["plan_1", "plan_2"]);
    for (const d of stored.due) expect(scKinds(d.reasons), d.planId).toEqual([]);
    // Due again at once (the erase's word), not a day after this look.
    expect(Date.parse(stored.nextAt)).toBeLessThanOrEqual(later.getTime());
    expect(stored.searchConsoleClears).toBe(1);
    expect(doc.nextAt).toBe(stored.nextAt);

    // The next look starts after the erase, so the figures still read come back, and a day passes.
    const next = new Date(later.getTime() + 120_000);
    await run(next);
    expect(scKinds(await reasonsOf("plan_1"))).toEqual(["losing_clicks", "within_reach"]);
    expect((await watchDoc()).nextAt).toBe(new Date(next.getTime() + 86_400_000).toISOString());
  });
});
