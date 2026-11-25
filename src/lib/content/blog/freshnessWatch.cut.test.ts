import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { BlogArticleMetaSchema, BlogBriefSchema } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import { agentArticlesDue } from "./freshnessAgentApi";
import { clearSearchConsoleReasons } from "./freshnessErase";
import { readDueArticles } from "./freshnessPages";
import { FRESHNESS_WATCH, freshnessWatchId, runFreshness, sweepBrand } from "./freshnessWatch";
import { setArticleLive } from "./live";
import { sampleHub, samplePlan } from "./testing/samplePlan";

/**
 * A look a tick's time cuts short (BLOG_FRESHNESS_ENABLED): it is due again at the next tick and
 * goes on with the articles it didn't reach, and until then every live article keeps its last
 * state and its row on the due list.
 */

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const ADMIN: TenantContext = { ...A, source: "idtoken", role: "admin" };
const DAY = 86_400_000;
const NOW = new Date("2026-11-24T12:00:00.000Z");
/** A week and a day on, so every article's links are due a check again. */
const LATER = new Date(NOW.getTime() + 8 * DAY);
/** The next tick, the same day. */
const NEXT_TICK = new Date(LATER.getTime() + 2 * 60_000);

const LINK = (p: string) => `https://research.example.org/${p}`;
const tenant = { id: "ten_A", region: "us", status: "active" } as unknown as Tenant;
const tenantB = { id: "ten_B", region: "us", status: "active" } as unknown as Tenant;

/** A made-up live article with an old figure (so it is due), its own page and these outbound links. */
function seedArticle(
  db: FakeFirestore,
  id: string,
  createdAt: string,
  slug: string,
  links: string[],
  brand: { tenantId: string; workspaceId: string; host: string } = { tenantId: "ten_A", workspaceId: "ws1", host: "acme.example" },
  published = "2026-10-20",
) {
  const url = `https://${brand.host}/blog/${slug}`;
  const body = `# ${slug}\n\nIn 2023, 38% of buyers asked an AI assistant first. ${links.map((l, i) => `See [source ${i + 1}](${l}).`).join(" ")}`;
  const hub = sampleHub({
    body,
    status: "approved",
    blog: { ...BlogArticleMetaSchema.parse({}), live: { url, at: "2026-10-21T08:00:00.000Z", by: "check", titleMatched: true }, dates: { published: { at: published, source: "page" } } },
  });
  db.seed(
    `workspaces/${brand.workspaceId}/content_plans`,
    id,
    samplePlan({ id, tenantId: brand.tenantId, workspaceId: brand.workspaceId, createdAt, updatedAt: createdAt, blog: BlogBriefSchema.parse({ subjectId: "sub_1" }), strategy: { objective: "brand_visibility", hubUrl: url } }, hub),
  );
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
      // It reached no article, so it waits a while rather than take the next tick too.
      const waits = new Date(at.getTime() + FRESHNESS_WATCH.EMPTY_CUT_WAIT_MS).toISOString();
      expect(doc.counts).toEqual(first.counts);
      expect(doc.byClock).toEqual(first.byClock);
      expect(doc.due).toEqual(first.due);
      expect(doc.pages).toEqual(first.pages);
      expect(doc.nextAt).toBe(waits);
      expect(doc.lookStartedAt).toBe(LATER.toISOString());
      expect(await watch(db)).toMatchObject({ nextAt: waits, lookStartedAt: LATER.toISOString(), counts: first.counts, due: first.due, pages: first.pages });
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

  it("waits a while after a tick that ran out before any article, rather than take every tick", async () => {
    const db = world();
    await tick(db, NOW);
    // The brand's reads before its first article take all the time the tick has.
    const slowReads = (db: FakeFirestore, now: Date) => {
      checked.length = 0;
      const deadlineMs = Date.now() + 60_000;
      return runFreshness(
        { deadlineMs },
        {
          ...deps(db, now),
          losingPages: async () => {
            vi.spyOn(Date, "now").mockReturnValue(deadlineMs + 1);
            return new Map<string, string>();
          },
        },
      ).finally(() => vi.restoreAllMocks());
    };
    expect(await slowReads(db, LATER)).toMatchObject({ brands: 1 });
    expect(checked).toEqual([]);
    expect(await sweptAt(db, "plan_new")).toBe(NOW.toISOString());

    // Not at the next tick, nor the ones after, for half an hour.
    expect(await tick(db, NEXT_TICK)).toMatchObject({ brands: 0 });
    expect(await tick(db, new Date(LATER.getTime() + FRESHNESS_WATCH.EMPTY_CUT_WAIT_MS - 1))).toMatchObject({ brands: 0 });
    // Then it looks again, and finishes.
    const back = new Date(LATER.getTime() + FRESHNESS_WATCH.EMPTY_CUT_WAIT_MS);
    expect(await tick(db, back)).toEqual({ brands: 1, articles: 2, due: 2 });
    expect(await sweptAt(db, "plan_old")).toBe(back.toISOString());
    expect(await watch(db)).toMatchObject({ lookStartedAt: null, nextAt: new Date(back.getTime() + DAY).toISOString() });
  });

  it("looks first at the brand that has waited longest, so a look going on gives way to it", async () => {
    const db = world();
    db.seed("workspaces", "wsB", { tenantId: "ten_B", name: "Blog", createdAt: "2026-01-01T00:00:00.000Z" });
    seedArticle(db, "plan_b", "2026-10-08T08:00:00.000Z", "b", [LINK("e")], { tenantId: "ten_B", workspaceId: "wsB", host: "fernhill.example" });
    /** A tick across both brands, listed A then B; cut: out of time at the first link check. */
    const lane = (now: Date, cut = false) => {
      checked.length = 0;
      const deadlineMs = Date.now() + 60_000;
      return runFreshness(
        { deadlineMs },
        {
          ...deps(db, now, () => {
            if (cut) vi.spyOn(Date, "now").mockReturnValue(deadlineMs + 1);
          }),
          listTenants: async () => [tenant, tenantB],
        },
      ).finally(() => vi.restoreAllMocks());
    };
    const sweptB = async () => (await getContentPlan(B, "wsB", "plan_b", db))!.graph.nodes[0]!.blog?.freshness?.sweptAt ?? null;

    expect(await lane(NOW)).toMatchObject({ brands: 2 });
    // A day on, A's look is cut after its first article, and B has no time.
    expect(await lane(LATER, true)).toMatchObject({ brands: 1 });
    expect(await sweptB()).toBe(NOW.toISOString());
    // B has waited since its look was due, A only since the last tick: B goes first.
    expect(await lane(NEXT_TICK, true)).toMatchObject({ brands: 1 });
    expect(checked).toEqual([LINK("e")]);
    expect(await sweptB()).toBe(NEXT_TICK.toISOString());
    expect(await sweptAt(db, "plan_old")).toBe(NOW.toISOString());
    // Then A goes on where it stopped.
    const after = new Date(NEXT_TICK.getTime() + 2 * 60_000);
    expect(await lane(after)).toMatchObject({ brands: 1 });
    expect(checked).toEqual([LINK("a"), LINK("b")]);
    expect(await sweptAt(db, "plan_old")).toBe(after.toISOString());
  });

  it("keeps a due article on the list after a look over several ticks, when the list has room for it", async () => {
    const db = new FakeFirestore();
    db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog", createdAt: "2026-01-01T00:00:00.000Z" });
    // One more due article than the list holds, on one clock. plan_p1 is read first (the newest
    // plan) and is due last (published last), so a full look leaves it off the list.
    seedArticle(db, "plan_p1", "2026-10-30T08:00:00.000Z", "p1", [LINK("p1")], undefined, "2026-10-10");
    for (let i = 2; i <= FRESHNESS_WATCH.MAX_DUE + 1; i += 1) {
      seedArticle(db, `plan_p${i}`, new Date(Date.parse("2026-09-01T08:00:00.000Z") + i * 3_600_000).toISOString(), `p${i}`, [], undefined, "2026-10-01");
    }
    const oneClock = { ...tenant, refreshClock: 20 } as unknown as Tenant;
    const lane = (now: Date, cut = false) => {
      const deadlineMs = Date.now() + 60_000;
      return runFreshness(
        { deadlineMs },
        {
          ...deps(db, now, () => {
            if (cut) vi.spyOn(Date, "now").mockReturnValue(deadlineMs + 1);
          }),
          listTenants: async () => [oneClock],
        },
      ).finally(() => vi.restoreAllMocks());
    };
    const listed = async () => (await watch(db)).due.map((d) => d.planId);

    await lane(NOW);
    expect(await listed()).toHaveLength(FRESHNESS_WATCH.MAX_DUE);
    expect(await listed()).not.toContain("plan_p1");
    // The next look is cut after plan_p1, which ranks last again.
    await lane(LATER, true);
    expect(await sweptAt(db, "plan_p1")).toBe(LATER.toISOString());
    expect(await listed()).not.toContain("plan_p1");
    // An article on the list is taken off live, so the list has room.
    const p2 = (await getContentPlan(A, "ws1", "plan_p2", db))!;
    expect((await setArticleLive(ADMIN, { workspaceId: "ws1", plan: p2, nodeId: "hub", action: "clear" }, { db, now: () => LATER })).ok).toBe(true);

    expect(await lane(NEXT_TICK)).toMatchObject({ brands: 1, due: FRESHNESS_WATCH.MAX_DUE });
    const done = await watch(db);
    expect(done.lookStartedAt).toBeNull();
    expect(done.due).toHaveLength(FRESHNESS_WATCH.MAX_DUE);
    expect(done.due.at(-1)).toEqual({
      planId: "plan_p1",
      workspaceId: "ws1",
      title: "p1",
      url: "https://acme.example/blog/p1",
      state: "due",
      reasons: expect.arrayContaining([expect.objectContaining({ kind: "age" }), expect.objectContaining({ kind: "old_figure" })]),
      dueAt: "2026-10-30T00:00:00.000Z",
      clockDays: 20,
      subjectId: "sub_1",
    });
  });
});

describe("an erase and a look cut short", () => {
  const KEY_NEW = "acme.example/blog/new";
  const fixedClock = { ...tenant, refreshClock: 45 } as unknown as Tenant;

  /**
   * Three live articles, read newest first: plan_new is due only because Search Console says it is
   * losing clicks (no old figure, published lately, on a 45-day clock); the other two have an old
   * figure. Each has one outbound link.
   */
  function erasedWorld() {
    const db = world();
    const url = "https://acme.example/blog/new";
    const hub = sampleHub({
      body: "# new\n\nAnswer engines answer a question in place of a list of links. See [a source](https://research.example.org/n).",
      status: "approved",
      blog: { ...BlogArticleMetaSchema.parse({}), live: { url, at: "2026-11-21T08:00:00.000Z", by: "check", titleMatched: true }, dates: { published: { at: "2026-11-20", source: "page" } } },
    });
    db.seed(
      "workspaces/ws1/content_plans",
      "plan_new",
      samplePlan({ id: "plan_new", tenantId: "ten_A", workspaceId: "ws1", createdAt: "2026-10-08T08:00:00.000Z", updatedAt: "2026-10-08T08:00:00.000Z", blog: BlogBriefSchema.parse({ subjectId: "sub_1" }), strategy: { objective: "brand_visibility", hubUrl: url } }, hub),
    );
    seedArticle(db, "plan_mid", "2026-10-05T08:00:00.000Z", "mid", [LINK("m")]);
    return db;
  }

  /** Search Console: connected until the erase, and then nothing to read. */
  let connected = true;
  /** One tick; `onLink(n)` runs at the nth link check of the tick (1 is plan_new's). */
  async function lane(db: FakeFirestore, now: Date, onLink: (n: number, deadlineMs: number) => Promise<void> = async () => {}) {
    checked.length = 0;
    const deadlineMs = Date.now() + 60_000;
    let n = 0;
    try {
      return await runFreshness(
        { deadlineMs },
        {
          ...deps(db, now),
          listTenants: async () => [fixedClock],
          losingPages: async () => (connected ? new Map([[KEY_NEW, "Search Console: 120 clicks, down from 260."]]) : new Map<string, string>()),
          checkLink: async (link: string) => {
            checked.push(link);
            n += 1;
            await onLink(n, deadlineMs);
            return "ok" as const;
          },
        },
      );
    } finally {
      vi.restoreAllMocks();
    }
  }
  const cutAt = (at: number) => async (n: number, deadlineMs: number) => {
    if (n === at) vi.spyOn(Date, "now").mockReturnValue(deadlineMs + 1);
  };
  const freshnessOf = async (db: FakeFirestore, planId: string) => (await getContentPlan(A, "ws1", planId, db))!.graph.nodes[0]!.blog!.freshness!;

  beforeEach(() => {
    connected = true;
  });

  /** After the erase, the next tick looks at every article: none stays due with no reason. */
  async function expectFullLookAfter(db: FakeFirestore) {
    expect(await lane(db, NEXT_TICK)).toEqual({ brands: 1, articles: 3, due: 2 });
    for (const planId of ["plan_new", "plan_mid", "plan_old"]) expect(await sweptAt(db, planId), planId).toBe(NEXT_TICK.toISOString());
    expect(await freshnessOf(db, "plan_new")).toMatchObject({ state: "fresh", reasons: [] });
    const done = await watch(db);
    expect(done).toMatchObject({ lookStartedAt: null, counts: { fresh: 1, soon: 0, due: 2 } });
    expect(done.due.map((d) => d.planId).sort()).toEqual(["plan_mid", "plan_old"]);
    for (const d of done.due) expect(d.reasons.length, d.planId).toBeGreaterThan(0);
  }

  it("between ticks: the next tick looks again at the articles the cut look passed", async () => {
    const db = erasedWorld();
    await lane(db, NOW);
    // The look is cut after plan_new, which it finds due because of lost clicks.
    await lane(db, LATER, cutAt(1));
    expect(checked).toEqual([LINK("n")]);
    expect(await freshnessOf(db, "plan_new")).toMatchObject({ state: "due", reasons: [expect.objectContaining({ kind: "losing_clicks" })] });
    expect((await watch(db)).lookStartedAt).toBe(LATER.toISOString());

    // Search Console is disconnected before the next tick.
    connected = false;
    await clearSearchConsoleReasons(A, { db, now: new Date(LATER.getTime() + 60_000) });
    expect((await watch(db)).lookStartedAt).toBeNull();

    await expectFullLookAfter(db);
  });

  it("during a cut tick: the look starts over at the next tick", async () => {
    const db = erasedWorld();
    await lane(db, NOW);
    // plan_new is written with its lost clicks; then, at plan_mid's link check, Search Console is
    // disconnected and the tick runs out of time, so plan_old isn't reached.
    await lane(db, LATER, async (n, deadlineMs) => {
      if (n !== 2) return;
      connected = false;
      await clearSearchConsoleReasons(A, { db, now: LATER });
      vi.spyOn(Date, "now").mockReturnValue(deadlineMs + 1);
    });
    expect(checked).toEqual([LINK("n"), LINK("m")]);
    expect(await sweptAt(db, "plan_old")).toBe(NOW.toISOString());
    // The erase took plan_new's reason off, and the look that it landed in doesn't go on.
    expect(await freshnessOf(db, "plan_new")).toMatchObject({ state: "due", reasons: [] });
    expect((await watch(db)).lookStartedAt).toBeNull();

    await expectFullLookAfter(db);
  });

  it("a pending erase tried again before every tick starts the look over once, then lets it finish", async () => {
    const db = erasedWorld();
    /** One tick that has time for one article only. */
    const oneArticle = async (at: Date) => {
      const deadlineMs = 1_000_000;
      let calls = 0;
      vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? 0 : deadlineMs + 1));
      try {
        await sweepBrand(A, fixedClock, {
          ...deps(db, at),
          deadlineMs,
          losingPages: async () => (connected ? new Map([[KEY_NEW, "Search Console: 120 clicks, down from 260."]]) : new Map<string, string>()),
        });
      } finally {
        vi.restoreAllMocks();
      }
    };
    await lane(db, NOW);
    await oneArticle(LATER);
    expect(await freshnessOf(db, "plan_new")).toMatchObject({ state: "due", reasons: [expect.objectContaining({ kind: "losing_clicks" })] });
    expect(await watch(db)).toMatchObject({ lookStartedAt: LATER.toISOString(), searchConsoleInLook: true });

    // Search Console is disconnected and its erase stays pending: the lane tries it again before
    // each tick. The first try starts the look over, as it wrote lost clicks; the tries after find
    // a look that wrote none, and let it go on.
    connected = false;
    let at = LATER;
    for (const planId of ["plan_new", "plan_mid", "plan_old"]) {
      await clearSearchConsoleReasons(A, { db, now: new Date(at.getTime() + 60_000) });
      at = new Date(at.getTime() + 2 * 60_000);
      await oneArticle(at);
      expect(await sweptAt(db, planId), planId).toBe(at.toISOString());
    }
    expect(await freshnessOf(db, "plan_new")).toMatchObject({ state: "fresh", reasons: [] });
    expect(await watch(db)).toMatchObject({ lookStartedAt: null, searchConsoleInLook: false, nextAt: new Date(at.getTime() + DAY).toISOString(), counts: { fresh: 1, soon: 0, due: 2 } });
  });

  it("an erase tried again during a cut tick that wrote no Search Console reason lets the look go on", async () => {
    const db = erasedWorld();
    connected = false;
    await lane(db, NOW);
    await lane(db, LATER, cutAt(1));
    expect(await watch(db)).toMatchObject({ lookStartedAt: LATER.toISOString(), searchConsoleInLook: false });

    // The retry lands at plan_mid's link check, and the tick runs out of time there.
    await lane(db, NEXT_TICK, async (n, deadlineMs) => {
      if (n !== 1) return;
      await clearSearchConsoleReasons(A, { db, now: NEXT_TICK });
      vi.spyOn(Date, "now").mockReturnValue(deadlineMs + 1);
    });
    expect(checked).toEqual([LINK("m")]);
    expect((await watch(db)).lookStartedAt).toBe(LATER.toISOString());

    // The next tick reaches plan_old and finishes the look.
    const after = new Date(NEXT_TICK.getTime() + 2 * 60_000);
    await lane(db, after);
    expect(checked).toEqual([LINK("a"), LINK("b")]);
    expect(await sweptAt(db, "plan_new")).toBe(LATER.toISOString());
    expect(await watch(db)).toMatchObject({ lookStartedAt: null, nextAt: new Date(after.getTime() + DAY).toISOString() });
  });
});
