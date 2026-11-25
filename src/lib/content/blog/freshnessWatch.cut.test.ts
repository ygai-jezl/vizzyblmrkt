import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { BlogArticleMetaSchema, BlogBriefSchema } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import { agentArticlesDue } from "./freshnessAgentApi";
import { readDueArticles } from "./freshnessPages";
import { freshnessWatchId, runFreshness, sweepBrand } from "./freshnessWatch";
import { setArticleLive } from "./live";
import { sampleHub, samplePlan } from "./testing/samplePlan";

/**
 * A look a tick's time cuts short (BLOG_FRESHNESS_ENABLED): it is due again at the next tick and
 * goes on with the articles it didn't reach, and until then every live article keeps its last
 * state and its row on the due list.
 */

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const ADMIN: TenantContext = { ...A, source: "idtoken", role: "admin" };
const PLANS = "workspaces/ws1/content_plans";
const DAY = 86_400_000;
const NOW = new Date("2026-11-24T12:00:00.000Z");
/** A week and a day on, so every article's links are due a check again. */
const LATER = new Date(NOW.getTime() + 8 * DAY);
/** The next tick, the same day. */
const NEXT_TICK = new Date(LATER.getTime() + 2 * 60_000);

const LINK = (p: string) => `https://research.example.org/${p}`;
const tenant = { id: "ten_A", region: "us", status: "active" } as unknown as Tenant;

/** A made-up live article with an old figure (so it is due), its own page and these outbound links. */
function seedArticle(db: FakeFirestore, id: string, createdAt: string, slug: string, links: string[]) {
  const url = `https://acme.example/blog/${slug}`;
  const body = `# ${slug}\n\nIn 2023, 38% of buyers asked an AI assistant first. ${links.map((l, i) => `See [source ${i + 1}](${l}).`).join(" ")}`;
  const hub = sampleHub({
    body,
    status: "approved",
    blog: { ...BlogArticleMetaSchema.parse({}), live: { url, at: "2026-10-21T08:00:00.000Z", by: "check", titleMatched: true }, dates: { published: { at: "2026-10-20", source: "page" } } },
  });
  db.seed(PLANS, id, samplePlan({ id, createdAt, updatedAt: createdAt, blog: BlogBriefSchema.parse({ subjectId: "sub_1" }), strategy: { objective: "brand_visibility", hubUrl: url } }, hub));
}

/** Two live articles: the watch reaches plan_new first, as plans are read newest first. */
function world() {
  const db = new FakeFirestore();
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog", createdAt: "2026-01-01T00:00:00.000Z" });
  seedArticle(db, "plan_new", "2026-10-08T08:00:00.000Z", "new", [LINK("c")]);
  seedArticle(db, "plan_old", "2026-10-01T08:00:00.000Z", "old", [LINK("a"), LINK("b")]);
  return db;
}

const checked: string[] = [];
const deps = (db: FakeFirestore, now: Date, onLink: () => void = () => {}) => ({
  db,
  now: () => now,
  rand: () => 0,
  listTenants: async () => [tenant],
  losingPages: async () => new Map<string, string>(),
  reachPages: async () => new Map<string, string>(),
  openQuestions: async () => new Map([["sub_1", 3]]),
  checkLink: async (url: string) => {
    checked.push(url);
    onLink();
    return "ok" as const;
  },
});

/** One tick's freshness lane. Cut: the tick runs out of time during the first article's link check. */
async function tick(db: FakeFirestore, now: Date, cut = false) {
  checked.length = 0;
  const deadlineMs = Date.now() + 60_000;
  try {
    return await runFreshness(
      { deadlineMs },
      deps(db, now, () => {
        if (cut) vi.spyOn(Date, "now").mockReturnValue(deadlineMs + 1);
      }),
    );
  } finally {
    vi.restoreAllMocks();
  }
}

const watch = async (db: FakeFirestore) => (await forTenant(A, db).freshnessWatch.getById(freshnessWatchId("ten_A")))!;
const sweptAt = async (db: FakeFirestore, planId: string) => (await getContentPlan(A, "ws1", planId, db))!.graph.nodes[0]!.blog?.freshness?.sweptAt ?? null;
const PAGE_NEW = { key: "acme.example/blog/new", planId: "plan_new", workspaceId: "ws1" };
const PAGE_OLD = { key: "acme.example/blog/old", planId: "plan_old", workspaceId: "ws1" };

beforeEach(() => {
  checked.length = 0;
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BLOG_DATES_ENABLED", "true");
  vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("a freshness look cut short", () => {
  it("keeps every article on the lists, is due at the next tick, and goes on from where it stopped", async () => {
    const db = world();
    expect(await tick(db, NOW)).toEqual({ brands: 1, articles: 2, due: 2 });
    expect(checked).toEqual([LINK("c"), LINK("a"), LINK("b")]);

    // The tick's time runs out after the first article.
    expect(await tick(db, LATER, true)).toEqual({ brands: 1, articles: 2, due: 2 });
    expect(checked).toEqual([LINK("c")]);
    expect(await sweptAt(db, "plan_new")).toBe(LATER.toISOString());
    expect(await sweptAt(db, "plan_old")).toBe(NOW.toISOString());
    const cut = await watch(db);
    expect(cut).toMatchObject({ nextAt: LATER.toISOString(), lookStartedAt: LATER.toISOString(), counts: { fresh: 0, soon: 0, due: 2 }, byClock: { "20": 1, "30": 1, "45": 0 }, linksToday: 1 });
    expect(cut.due.map((d) => d.planId)).toEqual(["plan_new", "plan_old"]);
    expect(cut.pages).toEqual([PAGE_NEW, PAGE_OLD]);
    expect((await readDueArticles(A, { db })).map((d) => d.planId)).toEqual(["plan_new", "plan_old"]);
    expect((await agentArticlesDue(A, { db })).body).toMatchObject({ articlesDue: 2, articles: [expect.anything(), expect.anything()] });

    // The next tick goes on with the article it didn't reach, and finishes the look.
    expect(await tick(db, NEXT_TICK)).toEqual({ brands: 1, articles: 2, due: 2 });
    expect(checked).toEqual([LINK("a"), LINK("b")]);
    expect(await sweptAt(db, "plan_new")).toBe(LATER.toISOString());
    expect(await sweptAt(db, "plan_old")).toBe(NEXT_TICK.toISOString());
    const done = await watch(db);
    expect(done).toMatchObject({ nextAt: new Date(NEXT_TICK.getTime() + DAY).toISOString(), lookStartedAt: null, counts: { fresh: 0, soon: 0, due: 2 }, linksToday: 3 });
    expect(done.due.map((d) => d.planId)).toEqual(["plan_new", "plan_old"]);
    expect(done.pages).toEqual([PAGE_NEW, PAGE_OLD]);

    // Then once a day again.
    expect(await tick(db, new Date(NEXT_TICK.getTime() + 2 * 60_000))).toMatchObject({ brands: 0 });
  });

  it("with no time for any article, changes nothing but when it looks next, however often it runs", async () => {
    const db = world();
    const first = await sweepBrand(A, tenant, deps(db, NOW));
    checked.length = 0;
    for (const at of [LATER, NEXT_TICK]) {
      const doc = await sweepBrand(A, tenant, { ...deps(db, at), deadlineMs: Date.now() - 1 });
      expect(doc.counts).toEqual(first.counts);
      expect(doc.byClock).toEqual(first.byClock);
      expect(doc.due).toEqual(first.due);
      expect(doc.pages).toEqual(first.pages);
      expect(doc.nextAt).toBe(at.toISOString());
      expect(doc.lookStartedAt).toBe(LATER.toISOString());
      expect(await watch(db)).toMatchObject({ nextAt: at.toISOString(), lookStartedAt: LATER.toISOString(), counts: first.counts, due: first.due, pages: first.pages });
    }
    expect(checked).toEqual([]);
    expect(await sweptAt(db, "plan_new")).toBe(NOW.toISOString());
    expect(await sweptAt(db, "plan_old")).toBe(NOW.toISOString());
  });

  it("drops an article taken off live during the look, and looks at one that went live meanwhile", async () => {
    const db = world();
    await tick(db, NOW);
    await tick(db, LATER, true);
    const old = (await getContentPlan(A, "ws1", "plan_old", db))!;
    expect((await setArticleLive(ADMIN, { workspaceId: "ws1", plan: old, nodeId: "hub", action: "clear" }, { db, now: () => LATER })).ok).toBe(true);
    seedArticle(db, "plan_newest", "2026-10-15T08:00:00.000Z", "newest", [LINK("d")]);

    expect(await tick(db, NEXT_TICK)).toEqual({ brands: 1, articles: 2, due: 2 });
    expect(checked).toEqual([LINK("d")]);
    expect(await sweptAt(db, "plan_new")).toBe(LATER.toISOString());
    expect(await sweptAt(db, "plan_newest")).toBe(NEXT_TICK.toISOString());
    const doc = await watch(db);
    expect(doc.due.map((d) => d.planId).sort()).toEqual(["plan_new", "plan_newest"]);
    expect(doc.pages).toEqual([{ key: "acme.example/blog/newest", planId: "plan_newest", workspaceId: "ws1" }, PAGE_NEW]);
    expect(doc).toMatchObject({ counts: { fresh: 0, soon: 0, due: 2 }, lookStartedAt: null });
  });

  it("starts over when it was left for more than a day", async () => {
    const db = world();
    await tick(db, NOW);
    await tick(db, LATER, true);
    expect((await watch(db)).lookStartedAt).toBe(LATER.toISOString());

    const twoDaysOn = new Date(LATER.getTime() + 2 * DAY);
    expect(await tick(db, twoDaysOn)).toEqual({ brands: 1, articles: 2, due: 2 });
    expect(await sweptAt(db, "plan_new")).toBe(twoDaysOn.toISOString());
    expect(await sweptAt(db, "plan_old")).toBe(twoDaysOn.toISOString());
    expect(await watch(db)).toMatchObject({ lookStartedAt: null, nextAt: new Date(twoDaysOn.getTime() + DAY).toISOString() });
  });
});
