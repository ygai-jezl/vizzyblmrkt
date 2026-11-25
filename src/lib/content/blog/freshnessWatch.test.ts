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

function world(over: { refreshClock?: Tenant["refreshClock"] } = {}) {
  const db = new FakeFirestore();
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog", createdAt: "2026-01-01T00:00:00.000Z" });
  const brief = BlogBriefSchema.parse({ subjectId: "sub_1", sources: [BlogSourceSchema.parse({ url: "https://research.example.org/2023", year: 2023 })] });
  const blog = BlogArticleMetaSchema.parse({});
  const hub = sampleHub({
    body: BODY,
    status: "approved",
    blog: { ...blog, live: { url: URL_, at: "2026-10-21T08:00:00.000Z", by: "check", titleMatched: true }, dates: { published: { at: "2026-10-20", source: "page" } } },
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
