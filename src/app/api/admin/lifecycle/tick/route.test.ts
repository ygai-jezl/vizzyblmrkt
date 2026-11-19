import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { POST } = await import("./route");

const machine = () => new Request("http://localhost/api/admin/lifecycle/tick", { method: "POST", headers: { "x-worker-secret": "s3cret-value-for-tests" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LIFECYCLE_WORKER_SECRET", "s3cret-value-for-tests");
});
afterEach(() => vi.unstubAllEnvs());

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
});

