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
  });
});
