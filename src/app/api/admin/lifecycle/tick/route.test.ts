import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

// The scheduler's tick: journeys, then Competitors' checks with what is left of the request's time.
// Each job's code loads only when its branch runs (await import()); `loaded` records which loaded.
const loaded = vi.hoisted(() => new Set<string>());
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const runner = vi.hoisted(() => ({ runLifecycleTick: vi.fn(async () => ({ tenants: 2 })), drainLifecycleTenant: vi.fn(async () => ({})) }));
vi.mock("@/lib/lifecycle/runner", () => (loaded.add("journeys"), runner));
const waitlist = vi.hoisted(() => ({ runWaitlistTick: vi.fn(async () => null) }));
vi.mock("@/lib/lifecycle/waitlist/tick", () => (loaded.add("waitlist"), waitlist));
const competitors = vi.hoisted(() => ({ runCompetitorChecks: vi.fn(async () => ({ tenants: 1, advanced: 1, failed: 0, scanned: true })) }));
vi.mock("@/lib/competitors/tick", () => (loaded.add("competitors"), competitors));
const articles = vi.hoisted(() => ({ runArticleReads: vi.fn(async () => ({ tenants: 1, queued: 2, read: 1, failed: 0, skipped: 0 })) }));
vi.mock("@/lib/competitors/articleTick", () => (loaded.add("competitor-articles"), articles));
const strategyCheck = vi.hoisted(() => ({ runStrategyChecks: vi.fn(async () => ({ brands: 2, open: 1, failed: 0 })) }));
vi.mock("@/lib/brandStrategy/check", () => (loaded.add("strategy-check"), strategyCheck));
const search = vi.hoisted(() => ({ runSearchSweeps: vi.fn(async () => ({ scanned: 1, indexed: 2 })) }));
vi.mock("@/lib/search/sweep", () => (loaded.add("search"), search));
const signals = vi.hoisted(() => ({ runSignals: vi.fn(async () => ({ tenants: 1, ready: 2, failed: 0, waiting: 1 })) }));
vi.mock("@/lib/signals/tick", () => (loaded.add("signals"), signals));
const autopilot = vi.hoisted(() => ({ runAutopilot: vi.fn(async () => ({ tenants: 1, started: 1, advanced: 2 })) }));
vi.mock("@/lib/autopilot/tick", () => (loaded.add("autopilot"), autopilot));
const liveWatch = vi.hoisted(() => ({ runLiveWatch: vi.fn(async () => ({ brands: 1, opened: 1, found: 0, approved: 0 })) }));
vi.mock("@/lib/content/blog/liveWatch", () => (loaded.add("live-watch"), liveWatch));
const freshness = vi.hoisted(() => ({ runFreshness: vi.fn(async () => ({ brands: 1, articles: 3, due: 1 })) }));
vi.mock("@/lib/content/blog/freshnessWatch", () => (loaded.add("freshness"), freshness));
const refresh = vi.hoisted(() => ({ runRefreshReviews: vi.fn(async () => ({ brands: 1, advanced: 2 })) }));
vi.mock("@/lib/content/blog/refreshReview", () => (loaded.add("refresh"), refresh));
const lane = vi.hoisted(() => ({ runConnectorsLane: vi.fn(async () => ({ brands: 2, connections: 1, days: 3, failed: 0, erased: 0, behindMin: 4 })) }));
vi.mock("@/lib/connectors/collect/tick", () => (loaded.add("connectors"), lane));
const fieldErase = vi.hoisted(() => ({ runFieldErase: vi.fn(async () => ({ brands: 2, jobs: 1, pages: 3 })) }));
vi.mock("@/lib/settings/eraseArchived", () => (loaded.add("field-erase"), fieldErase));
const agentRecord = vi.hoisted(() => ({ runAgentRecordCatchUp: vi.fn(async () => ({ brands: 1, read: 4, closed: 2 })) }));
vi.mock("@/lib/agentRecord/catchUp", () => (loaded.add("agent-record"), agentRecord));
// The clean-up runs for real over a fake account list; only its hourly gate and Auth are stubbed.
const rateLimit = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => rateLimit);
const DAY = 86_400_000;
const accounts = vi.hoisted(() => ({
  listUsers: vi.fn(async (): Promise<{ users: unknown[]; pageToken?: string }> => ({ users: [] })),
  deleteUser: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth/adminAuth", () => ({ adminAuth: () => accounts }));
vi.mock("@/lib/auth/cleanup", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/cleanup")>();
  return { ...real, runAuthCleanup: vi.fn(real.runAuthCleanup) };
});
const cleanup = await import("@/lib/auth/cleanup");
const runAuthCleanup = vi.mocked(cleanup.runAuthCleanup);
const unconfirmed = (uid: string) => ({
  uid,
  email: `${uid}@example.com`,
  emailVerified: false,
  providerData: [{ providerId: "password" }],
  metadata: { creationTime: new Date(Date.now() - 8 * DAY).toUTCString() },
});

const { POST } = await import("./route");
/** What loading the route itself loaded: none of the jobs. */
const loadedWithTheRoute = [...loaded];

const machine = () => new Request("http://localhost/api/admin/lifecycle/tick", { method: "POST", headers: { "x-worker-secret": "s3cret-value-for-tests" } });

let log: MockInstance<typeof console.log>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LIFECYCLE_WORKER_SECRET", "s3cret-value-for-tests");
  accounts.listUsers.mockResolvedValue({ users: [unconfirmed("u1")] });
  vi.spyOn(console, "info").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  log.mockRestore();
  vi.restoreAllMocks();
});

const tickLines = () => log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[tick] "));
const jobLines = () => tickLines().filter((line) => /^\[tick\] [a-z-]+ \d+ms$/.test(line));
const memoryLines = () => tickLines().filter((line) => line.startsWith("[tick] memory MiB "));

describe("the lifecycle tick with Competitors", () => {
  it("is a no-op for the scheduler with everything off", async () => {
    const res = await POST(machine());
    expect(await res.json()).toEqual({ ok: true, skipped: "lifecycle_disabled" });
    expect(competitors.runCompetitorChecks).not.toHaveBeenCalled();
  });

  it("runs only Competitors' checks when only they are on, within the time left", async () => {
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    const before = Date.now();
    const res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "all_tenants", competitors: { advanced: 1 } });
    expect(runner.runLifecycleTick).not.toHaveBeenCalled();
    const [{ deadlineMs }] = competitors.runCompetitorChecks.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(25_000 + 50);
  });

  it("runs the journeys first, and a failed check never fails the scheduler's call", async () => {
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    competitors.runCompetitorChecks.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(machine());
    expect(await res.json()).toMatchObject({ ok: true, tenants: 2, competitors: null });
  });

  it("never runs Competitors' checks for a signed-in admin", async () => {
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", role: "admin" });
    const res = await POST(new Request("http://localhost/api/admin/lifecycle/tick", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(competitors.runCompetitorChecks).not.toHaveBeenCalled();
    expect(articles.runArticleReads).not.toHaveBeenCalled();
  });

  it("reads competitor articles beside the checks only with their switch on, within their own time", async () => {
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    await POST(machine());
    expect(articles.runArticleReads).not.toHaveBeenCalled();

    vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "true");
    const before = Date.now();
    const res = await POST(machine());
    expect(await res.json()).toMatchObject({ competitors: { advanced: 1 }, competitorArticles: { read: 1 } });
    const [{ deadlineMs }] = articles.runArticleReads.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(40_000 + 50);
  });

  it("runs the weekly strategy check beside them only with its switch on, within its own time", async () => {
    for (const k of ["COMPETITORS_ENABLED", "COMPETITOR_ARTICLES_ENABLED", "BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "STRATEGY_COMPETITORS_ENABLED"]) vi.stubEnv(k, "true");
    expect(await (await POST(machine())).json()).not.toHaveProperty("strategyCheck");
    expect(strategyCheck.runStrategyChecks).not.toHaveBeenCalled();

    vi.stubEnv("STRATEGY_CHECK_ENABLED", "true");
    const before = Date.now();
    const res = await POST(machine());
    expect(await res.json()).toMatchObject({ competitors: { advanced: 1 }, strategyCheck: { brands: 2, open: 1 } });
    const [{ deadlineMs }] = strategyCheck.runStrategyChecks.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(10_000 + 50);

    // A run that looked at no brand adds nothing to the answer, and one that fails never fails the call.
    strategyCheck.runStrategyChecks.mockResolvedValueOnce({ brands: 0, open: 0, failed: 0 });
    expect(await (await POST(machine())).json()).not.toHaveProperty("strategyCheck");
    strategyCheck.runStrategyChecks.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failed = await POST(machine());
      expect(failed.status).toBe(200);
      expect(await failed.json()).toMatchObject({ ok: true, competitors: { advanced: 1 } });
    } finally {
      warn.mockRestore();
    }
  });

  it("never fails the scheduler's call when the article reads fail", async () => {
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "true");
    articles.runArticleReads.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, competitors: { advanced: 1 } });
  });

  it("collects finished Google lookups only with their switches on, within their own time, and never fails the call", async () => {
    vi.stubEnv("BRAND_SIGNALS_ENABLED", "true");
    let res = await POST(machine());
    expect(await res.json()).toEqual({ ok: true, skipped: "lifecycle_disabled" });
    expect(signals.runSignals).not.toHaveBeenCalled();

    vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "true");
    const before = Date.now();
    res = await POST(machine());
    expect(await res.json()).toMatchObject({ ok: true, mode: "all_tenants", signals: { ready: 2 } });
    const [{ deadlineMs }] = signals.runSignals.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(25_000 + 50);

    signals.runSignals.mockRejectedValueOnce(new Error("down"));
    res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("signals");
  });

  it("runs the article autopilot only with its switches on, within its own time", async () => {
    vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
    let res = await POST(machine());
    expect(autopilot.runAutopilot).not.toHaveBeenCalled();
    vi.stubEnv("CREATE_ARTICLE_AUTOPILOT_ENABLED", "true");
    const before = Date.now();
    res = await POST(machine());
    expect(await res.json()).toMatchObject({ ok: true, autopilot: { advanced: 2 } });
    const [{ deadlineMs }] = autopilot.runAutopilot.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(90_000 + 50);
  });

  it("runs connected data's lane with CONNECTORS_ENABLED alone, within its own time, and never fails the call", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    const before = Date.now();
    let res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "all_tenants", connectors: { brands: 2, days: 3 } });
    const [{ deadlineMs }] = lane.runConnectorsLane.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(25_000 + 50);

    lane.runConnectorsLane.mockRejectedValueOnce(new Error("down"));
    res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("connectors");
  });

  it("still answers 200 with every switch off, and never runs the lane", async () => {
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    const res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "lifecycle_disabled" });
    expect(lane.runConnectorsLane).not.toHaveBeenCalled();
  });
});

describe("the tick's log lines", () => {
  it("logs one line per job that ran and one memory line, with no brand ids", async () => {
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "true");
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    const res = await POST(machine());
    expect(res.status).toBe(200);
    expect(jobLines().map((line) => line.split(" ")[1]).sort()).toEqual(["competitor-articles", "competitors", "connectors", "journeys"]);
    expect(memoryLines()).toHaveLength(1);
    expect(memoryLines()[0]).toMatch(/rss=[\d.]+ heapUsed=[\d.]+ heapTotal=[\d.]+ external=[\d.]+ arrayBuffers=[\d.]+$/);
    expect(tickLines()).toHaveLength(5);
    expect(tickLines().join("\n")).not.toMatch(/ten_|@/);
  });

  it("logs a job that failed too", async () => {
    vi.stubEnv("BRAND_SIGNALS_ENABLED", "true");
    vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "true");
    signals.runSignals.mockRejectedValueOnce(new Error("down"));
    const res = await POST(machine());
    expect(res.status).toBe(200);
    expect(jobLines().map((line) => line.split(" ")[1])).toEqual(["signals"]);
    expect(memoryLines()).toHaveLength(1);
  });

  it("still logs the memory line when the journeys throw", async () => {
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    runner.runLifecycleTick.mockRejectedValueOnce(new Error("boom"));
    await expect(POST(machine())).rejects.toThrow("boom");
    expect(jobLines().map((line) => line.split(" ")[1])).toEqual(["journeys"]);
    expect(memoryLines()).toHaveLength(1);
  });

  it("still answers 200 when the memory can't be read, and a journeys error still comes through", async () => {
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    const memory = vi.spyOn(process, "memoryUsage").mockImplementation(() => {
      throw new Error("EMFILE: too many open files");
    });
    try {
      const res = await POST(machine());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, tenants: 2 });
      expect(jobLines().map((line) => line.split(" ")[1])).toEqual(["journeys"]);
      expect(memoryLines()).toEqual([]);

      runner.runLifecycleTick.mockRejectedValueOnce(new Error("boom"));
      await expect(POST(machine())).rejects.toThrow("boom");
    } finally {
      memory.mockRestore();
    }
  });

  it("logs nothing when the scheduler's call has nothing to run, or for a signed-in admin", async () => {
    await POST(machine());
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", role: "admin" });
    const res = await POST(new Request("http://localhost/api/admin/lifecycle/tick", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(tickLines()).toEqual([]);
  });
});

describe("each job's code loads only when its switch is on", () => {
  /** Each job's module and its mock. */
  const JOB_MODULES: Array<[name: string, path: string, mock: object]> = [
    ["journeys", "@/lib/lifecycle/runner", runner],
    ["waitlist", "@/lib/lifecycle/waitlist/tick", waitlist],
    ["competitors", "@/lib/competitors/tick", competitors],
    ["competitor-articles", "@/lib/competitors/articleTick", articles],
    ["strategy-check", "@/lib/brandStrategy/check", strategyCheck],
    ["search", "@/lib/search/sweep", search],
    ["signals", "@/lib/signals/tick", signals],
    ["autopilot", "@/lib/autopilot/tick", autopilot],
    ["live-watch", "@/lib/content/blog/liveWatch", liveWatch],
    ["freshness", "@/lib/content/blog/freshnessWatch", freshness],
    ["refresh", "@/lib/content/blog/refreshReview", refresh],
    ["connectors", "@/lib/connectors/collect/tick", lane],
    ["auth-cleanup", "@/lib/auth/cleanup", cleanup],
    ["field-erase", "@/lib/settings/eraseArchived", fieldErase],
    ["agent-record", "@/lib/agentRecord/catchUp", agentRecord],
  ];

  /**
   * A fresh copy of the route, with no job loaded yet. resetModules alone keeps a mocked module
   * once it has loaded, so each mock is registered again and records when it next loads.
   */
  async function freshRoute() {
    vi.resetModules();
    loaded.clear();
    for (const [name, path, mock] of JOB_MODULES) vi.doMock(path, () => (loaded.add(name), mock));
    return (await import("./route")).POST;
  }

  it("loads no job with the route itself", () => {
    expect(loadedWithTheRoute).toEqual([]);
  });

  it("still answers 200 with every switch off, and loads no job", async () => {
    const post = await freshRoute();
    const res = await post(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "lifecycle_disabled" });
    expect([...loaded]).toEqual([]);
  });

  it("loads only the journeys with only the journeys on", async () => {
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    const post = await freshRoute();
    const res = await post(machine());
    expect(await res.json()).toEqual({ ok: true, mode: "all_tenants", tenants: 2 });
    expect([...loaded]).toEqual(["journeys"]);
  });

  it("loads the password account clean-up only with PASSWORD_SIGNIN_ENABLED on", async () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    const post = await freshRoute();
    const res = await post(machine());
    expect(await res.json()).toMatchObject({ ok: true, authCleanup: { mode: "log_only" } });
    expect([...loaded]).toEqual(["auth-cleanup"]);
  });

  it("loads the erase lane only with SETTINGS_ERASE_ENABLED and what it needs on, and moves jobs on within its budget", async () => {
    for (const n of ["SETTINGS_HISTORY_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "PLANS_ENABLED"]) vi.stubEnv(n, "true");
    let post = await freshRoute();
    await post(machine());
    expect([...loaded]).not.toContain("field-erase");
    vi.stubEnv("SETTINGS_ERASE_ENABLED", "true");
    post = await freshRoute();
    const before = Date.now();
    const res = await post(machine());
    expect(await res.json()).toMatchObject({ ok: true, fieldErase: { jobs: 1, pages: 3 } });
    expect([...loaded]).toContain("field-erase");
    const [{ deadlineMs }] = fieldErase.runFieldErase.mock.calls.at(-1) as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(20_000 + 1000);
  });

  it("loads only the agent record's catch-up with only AGENT_RECORD_ENABLED on, within its own budget", async () => {
    vi.stubEnv("AGENT_RECORD_ENABLED", "true");
    const post = await freshRoute();
    const before = Date.now();
    const res = await post(machine());
    expect(await res.json()).toEqual({ ok: true, mode: "all_tenants", agentRecord: { brands: 1, read: 4, closed: 2 } });
    expect([...loaded]).toEqual(["agent-record"]);
    const [{ deadlineMs }] = agentRecord.runAgentRecordCatchUp.mock.calls.at(-1) as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(15_000 + 1000);
  });

  it("loads only the connected data lane with only CONNECTORS_ENABLED on", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    const post = await freshRoute();
    await post(machine());
    expect([...loaded]).toEqual(["connectors"]);
  });

  it("runs brand search's check and Found live from their own code when on", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
    vi.stubEnv("BLOG_LIVE_WATCH_ENABLED", "true");
    const post = await freshRoute();
    const before = Date.now();
    const res = await post(machine());
    expect(await res.json()).toMatchObject({ ok: true, search: { scanned: 1 }, liveWatch: { brands: 1 } });
    expect(new Set(loaded)).toEqual(new Set(["search", "live-watch"]));
    const [{ deadlineMs: searchDeadline }] = search.runSearchSweeps.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(searchDeadline - before).toBeLessThanOrEqual(30_000 + 50);
    const [{ deadlineMs: watchDeadline }] = liveWatch.runLiveWatch.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(watchDeadline - before).toBeLessThanOrEqual(25_000 + 50);
  });

  it("runs article freshness from its own code only with its switches on, within its own time", async () => {
    vi.stubEnv("BLOG_DATES_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
    const post = await freshRoute();
    const before = Date.now();
    const res = await post(machine());
    expect(await res.json()).toMatchObject({ ok: true, freshness: { brands: 1, due: 1 } });
    expect([...loaded]).toEqual(["freshness"]);
    const [{ deadlineMs }] = freshness.runFreshness.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(20_000 + 50);
    expect(jobLines().map((line) => line.split(" ")[1])).toEqual(["freshness"]);
  });

  it("moves refresh reviews from their own code only with their switch on, within their own time", async () => {
    for (const k of ["BLOG_DATES_ENABLED", "BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED"]) vi.stubEnv(k, "true");
    const post = await freshRoute();
    const before = Date.now();
    const res = await post(machine());
    expect(await res.json()).toMatchObject({ ok: true, refresh: { brands: 1, advanced: 2 } });
    expect([...loaded].sort()).toEqual(["freshness", "refresh"]);
    const [{ deadlineMs }] = refresh.runRefreshReviews.mock.calls[0] as unknown as [{ deadlineMs: number }];
    expect(deadlineMs - before).toBeLessThanOrEqual(90_000 + 50);
  });

  it("never fails the scheduler's call when article freshness fails", async () => {
    vi.stubEnv("BLOG_DATES_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
    vi.stubEnv("BLOG_FRESHNESS_ENABLED", "true");
    freshness.runFreshness.mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const post = await freshRoute();
      const res = await post(machine());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, mode: "all_tenants" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[freshness] tick failed: boom"));
    } finally {
      warn.mockRestore();
    }
  });

  it("loads every job that is on, and starts the others only once the journeys are done", async () => {
    for (const name of [
      "LIFECYCLE_ENABLED",
      "COMPETITORS_ENABLED",
      "COMPETITOR_ARTICLES_ENABLED",
      "SEARCH_INDEX_ENABLED",
      "BRAND_SIGNALS_ENABLED",
      "SIGNALS_DATAFORSEO_ENABLED",
      "BRAND_MAP_NEXT_UP_ENABLED",
      "CREATE_ARTICLE_AUTOPILOT_ENABLED",
      "BRAND_MAP_ENABLED",
      "BRAND_MAP_PAGES_ENABLED",
      "BLOG_LIVE_WATCH_ENABLED",
      "CONNECTORS_ENABLED",
    ]) {
      vi.stubEnv(name, "true");
    }
    const order: string[] = [];
    runner.runLifecycleTick.mockImplementationOnce(async () => {
      order.push("journeys started");
      await new Promise((r) => setTimeout(r, 5));
      order.push("journeys done");
      return { tenants: 2 };
    });
    search.runSearchSweeps.mockImplementationOnce(async () => (order.push("search"), { scanned: 1, indexed: 2 }));
    lane.runConnectorsLane.mockImplementationOnce(async () => (order.push("connectors"), { brands: 2, connections: 1, days: 3, failed: 0, erased: 0, behindMin: 4 }));
    const post = await freshRoute();
    const res = await post(machine());
    expect(await res.json()).toMatchObject({
      ok: true,
      tenants: 2,
      competitors: { advanced: 1 },
      competitorArticles: { read: 1 },
      search: { scanned: 1 },
      signals: { ready: 2 },
      autopilot: { advanced: 2 },
      liveWatch: { brands: 1 },
      connectors: { brands: 2 },
    });
    expect(new Set(loaded)).toEqual(
      new Set(["journeys", "competitors", "competitor-articles", "search", "signals", "autopilot", "live-watch", "connectors"]),
    );
    expect(order.slice(0, 2)).toEqual(["journeys started", "journeys done"]);
    expect(order).toContain("search");
    expect(order).toContain("connectors");
  });

  it("never fails the scheduler's call when a job's code fails to load", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const post = await freshRoute();
    vi.doMock("@/lib/connectors/collect/tick", () => {
      throw new Error("load failed");
    });
    try {
      const res = await post(machine());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, mode: "all_tenants" });
      expect(warn.mock.calls.map(([line]) => String(line)).some((line) => line.startsWith("[connectors] tick failed: "))).toBe(true);
      expect(lane.runConnectorsLane).not.toHaveBeenCalled();
    } finally {
      vi.doMock("@/lib/connectors/collect/tick", () => (loaded.add("connectors"), lane));
      warn.mockRestore();
    }
  });

  it("loads a signed-in admin's journeys only when they are on", async () => {
    vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
    session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", role: "admin" });
    const post = await freshRoute();
    const res = await post(new Request("http://localhost/api/admin/lifecycle/tick", { method: "POST" }));
    expect(await res.json()).toEqual({ ok: true, mode: "tenant" });
    expect([...loaded]).toEqual(["waitlist"]);
    expect(waitlist.runWaitlistTick).toHaveBeenCalledTimes(1);
    expect(runner.drainLifecycleTenant).not.toHaveBeenCalled();
  });
});

describe("the lifecycle tick with the password account clean-up", () => {
  const admin = () => new Request("http://localhost/api/admin/lifecycle/tick", { method: "POST" });

  it("with PASSWORD_SIGNIN_ENABLED off, behaves exactly as before: no gate, no account read", async () => {
    vi.stubEnv("PASSWORD_CLEANUP_DELETE_ENABLED", "true");
    let res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "lifecycle_disabled" });

    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    res = await POST(machine());
    expect(await res.json()).toEqual({ ok: true, mode: "all_tenants", tenants: 2 });

    vi.stubEnv("LIFECYCLE_ENABLED", "false");
    res = await POST(admin());
    expect(res.status).toBe(404);

    expect(runAuthCleanup).not.toHaveBeenCalled();
    expect(rateLimit.isRateLimited).not.toHaveBeenCalled();
    expect(accounts.listUsers).not.toHaveBeenCalled();
    expect(accounts.deleteUser).not.toHaveBeenCalled();
  });

  it("runs the clean-up for the scheduler with only PASSWORD_SIGNIN_ENABLED on, within its own time", async () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    const before = Date.now();
    const res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: "all_tenants", authCleanup: { mode: "log_only", wouldDelete: 1, deleted: 0 } });
    expect(runner.runLifecycleTick).not.toHaveBeenCalled();
    expect(rateLimit.isRateLimited).toHaveBeenCalledWith("auth-cleanup", { prefix: "auth-cleanup-run", burstLimit: 1, hourlyLimit: 1 });
    expect(accounts.deleteUser).not.toHaveBeenCalled();
    const [{ deadlineMs }] = runAuthCleanup.mock.calls[0]!;
    expect(deadlineMs - before).toBeLessThanOrEqual(10_000 + 50);
  });

  it("deletes only with the deletion switch on too", async () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    vi.stubEnv("PASSWORD_CLEANUP_DELETE_ENABLED", "true");
    const res = await POST(machine());
    expect(await res.json()).toMatchObject({ authCleanup: { mode: "delete", deleted: 1 } });
    expect(accounts.deleteUser).toHaveBeenCalledWith("u1");
  });

  it("runs at most once an hour: another instance's run this hour skips it", async () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    rateLimit.isRateLimited.mockResolvedValueOnce(true);
    const res = await POST(machine());
    expect(await res.json()).toEqual({ ok: true, mode: "all_tenants", tenants: 2 });
    expect(accounts.listUsers).not.toHaveBeenCalled();
  });

  it("runs beside the journeys and never fails them", async () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    runAuthCleanup.mockRejectedValueOnce(new Error("boom"));
    let res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "all_tenants", tenants: 2 });

    accounts.listUsers.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "auth/internal-error" }));
    res = await POST(machine());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tenants: 2, authCleanup: { error: "auth/internal-error" } });
  });

  it("never runs for a signed-in admin", async () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    let res = await POST(admin());
    expect(res.status).toBe(404);

    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", role: "admin" });
    res = await POST(admin());
    expect(await res.json()).toMatchObject({ ok: true, mode: "tenant" });
    expect(runAuthCleanup).not.toHaveBeenCalled();
    expect(accounts.listUsers).not.toHaveBeenCalled();
  });
});
