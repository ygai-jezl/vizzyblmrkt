import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

// The scheduler's tick: journeys, then Competitors' checks with what is left of the request's time.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const runner = vi.hoisted(() => ({ runLifecycleTick: vi.fn(async () => ({ tenants: 2 })), drainLifecycleTenant: vi.fn(async () => ({})) }));
vi.mock("@/lib/lifecycle/runner", () => runner);
const waitlist = vi.hoisted(() => ({ runWaitlistTick: vi.fn(async () => null) }));
vi.mock("@/lib/lifecycle/waitlist/tick", () => waitlist);
const competitors = vi.hoisted(() => ({ runCompetitorChecks: vi.fn(async () => ({ tenants: 1, advanced: 1, failed: 0, scanned: true })) }));
vi.mock("@/lib/competitors/tick", () => competitors);
const articles = vi.hoisted(() => ({ runArticleReads: vi.fn(async () => ({ tenants: 1, queued: 2, read: 1, failed: 0, skipped: 0 })) }));
vi.mock("@/lib/competitors/articleTick", () => articles);
const signals = vi.hoisted(() => ({ runSignals: vi.fn(async () => ({ tenants: 1, ready: 2, failed: 0, waiting: 1 })) }));
vi.mock("@/lib/signals/tick", () => signals);
const autopilot = vi.hoisted(() => ({ runAutopilot: vi.fn(async () => ({ tenants: 1, started: 1, advanced: 2 })) }));
vi.mock("@/lib/autopilot/tick", () => autopilot);
const lane = vi.hoisted(() => ({ runConnectorsLane: vi.fn(async () => ({ brands: 2, connections: 1, days: 3, failed: 0, erased: 0, behindMin: 4 })) }));
vi.mock("@/lib/connectors/collect/tick", () => lane);

const { POST } = await import("./route");

const machine = () => new Request("http://localhost/api/admin/lifecycle/tick", { method: "POST", headers: { "x-worker-secret": "s3cret-value-for-tests" } });

let log: MockInstance<typeof console.log>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LIFECYCLE_WORKER_SECRET", "s3cret-value-for-tests");
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  log.mockRestore();
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

  it("logs nothing when the scheduler's call has nothing to run, or for a signed-in admin", async () => {
    await POST(machine());
    vi.stubEnv("LIFECYCLE_ENABLED", "true");
    session.getAdminContext.mockResolvedValue({ tenantId: "ten_A", region: "us", role: "admin" });
    const res = await POST(new Request("http://localhost/api/admin/lifecycle/tick", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(tickLines()).toEqual([]);
  });
});
