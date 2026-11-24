import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { collectSignal, lookUpQuestion, ownHostsOf, type CollectDeps } from "./collect";
import type { DataForSeoFetch } from "./dataforseo";
import { FIRST_LOOK_MS, getSignal, lookupsThisMonth, recordPosted } from "./store";
import { runSignals } from "./tick";
import { envelope, SERP_RESULT } from "./testing/serpFixture";
import { usageThisMonth } from "@/lib/plans/meter";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const ENV = { DATAFORSEO_USERNAME: "api-user@example.com", DATAFORSEO_PASSWORD: "not-a-real-password" };
const ASK = { query: "How do I get cited by AI answers?", questionId: "q_1", subjectId: "sub_1" };

const tenant = (over: Partial<Tenant> = {}) =>
  ({ id: "ten_A", region: "us", allowedOrigins: ["https://brand.example.com"], grantedFeatures: ["next_up"], ...over }) as unknown as Tenant;
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function setup(t: Tenant | null = tenant()) {
  const clock = { t: Date.parse("2026-11-18T12:00:00.000Z") };
  const fetch = vi.fn<DataForSeoFetch>(async (url) =>
    String(url).includes("task_post")
      ? answer(envelope({ id: "aaaaaaaa-0001", status_code: 20100, cost: 0.0012 }))
      : answer(envelope({ id: "aaaaaaaa-0001", status_code: 20000, cost: 0, result: [SERP_RESULT] })),
  );
  const deps: CollectDeps & { db: FakeFirestore } = {
    db: new FakeFirestore(),
    now: () => new Date(clock.t),
    env: ENV,
    fetch,
    loadTenant: async () => t,
    ownHosts: ["brand.example.com"],
  };
  return { deps, fetch, clock };
}

beforeEach(() => {
  vi.stubEnv("BRAND_SIGNALS_ENABLED", "true");
  vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("looking a question up", () => {
  it("does nothing with the switch off, without a login, or for a brand without next_up", async () => {
    const { deps, fetch } = setup();
    vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "false");
    expect(await lookUpQuestion(A, ASK, deps)).toMatchObject({ ok: false, status: 503, error: "unavailable" });
    vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "true");
    expect(await lookUpQuestion(A, ASK, { ...deps, env: {} })).toMatchObject({ ok: false, status: 503, error: "not_set_up" });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "next_up");
    expect(await lookUpQuestion(A, ASK, { ...deps, loadTenant: async () => tenant({ grantedFeatures: [] }) })).toMatchObject({ ok: false, status: 403, error: "not_included" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts a new lookup at high priority in the brand's market, then reuses it while waiting and once ready", async () => {
    const { deps, fetch, clock } = setup(tenant({ searchMarket: { country: "GB", language: "en" } }));
    const first = await lookUpQuestion(A, ASK, deps);
    expect(first).toMatchObject({ ok: true, reused: false, signal: { status: "posted", market: { country: "GB" }, askedBy: "person", cost: 0.0012 } });
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))[0]).toMatchObject({ location_code: 2826, priority: 2 });
    expect(await lookUpQuestion(A, { ...ASK, query: " how do i get cited by AI answers " }, deps)).toMatchObject({ ok: true, reused: true });
    expect(fetch).toHaveBeenCalledTimes(1);

    clock.t += FIRST_LOOK_MS;
    const id = first.ok ? first.signal.id : "";
    expect(await collectSignal(A, (await getSignal(A, id, deps))!, ["brand.example.com"], deps)).toBe("ready");
    expect(await getSignal(A, id, deps)).toMatchObject({ status: "ready", numbers: { googlePosition: 3, peopleAlsoAsk: 3 } });
    expect(await lookUpQuestion(A, ASK, deps)).toMatchObject({ ok: true, reused: true, signal: { status: "ready" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops at the brand's monthly cap", async () => {
    const { deps, fetch } = setup(tenant({ featureLimits: { next_up: 1 } }));
    expect(await lookUpQuestion(A, ASK, deps)).toMatchObject({ ok: true });
    expect(await lookUpQuestion(A, { ...ASK, query: "Another question" }, deps)).toMatchObject({ ok: false, status: 429, error: "monthly_limit" });
    expect(await lookupsThisMonth(A, deps)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("puts each paid lookup on the usage meter by who asked, never a reused one", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { deps } = setup();
    await lookUpQuestion(A, ASK, deps);
    await lookUpQuestion(A, ASK, deps);
    await lookUpQuestion(A, { ...ASK, query: "Another question", purpose: "autopilot" }, deps);
    const m = await usageThisMonth(A, { db: deps.db, now: deps.now });
    expect(m.google_lookups).toMatchObject({ total: 2, calls: 2, byPurpose: { get_from_google: 1, autopilot: 1 } });
    // The purpose is the meter's: it isn't stored on the lookup.
    expect(JSON.stringify(deps.db.dump("brand_signals"))).not.toContain('"purpose"');
  });

  it("reports a refused lookup without storing anything", async () => {
    const { deps, fetch } = setup();
    fetch.mockResolvedValueOnce(answer(envelope({ id: "x", status_code: 40501 })));
    expect(await lookUpQuestion(A, ASK, deps)).toEqual({ ok: false, status: 502, error: "lookup_failed", detail: "dataforseo_40501" });
    expect(await lookupsThisMonth(A, deps)).toBe(0);
  });
});

describe("collecting", () => {
  it("looks again later when DataForSEO isn't ready, and fails on a refusal", async () => {
    const { deps, fetch, clock } = setup();
    const s = await recordPosted(A, { ...ASK, market: { country: "US", language: "en" }, askedBy: "schedule", taskId: "aaaaaaaa-0001", cost: null }, deps);
    clock.t += FIRST_LOOK_MS;
    fetch.mockResolvedValueOnce(answer(envelope({ id: "aaaaaaaa-0001", status_code: 40601 })));
    expect(await collectSignal(A, s, [], deps)).toBe("not_yet");
    expect(await getSignal(A, s.id, deps)).toMatchObject({ status: "posted", leaseId: null });
    fetch.mockResolvedValueOnce(answer(envelope({ id: "aaaaaaaa-0001", status_code: 40400 })));
    expect(await collectSignal(A, s, [], deps)).toBe("failed");
    expect(await getSignal(A, s.id, deps)).toMatchObject({ status: "failed", error: "dataforseo_40400" });
  });

  it("finds the brand's own hosts from its brand map site and origins", async () => {
    const { deps } = setup();
    deps.db.seed("brand_maps", "bm_ten_A", { tenantId: "ten_A", identity: { site: "https://www.brand.example.com/" } });
    const hosts = await ownHostsOf(A, tenant({ allowedOrigins: ["https://shop.example.com", "http://localhost:3002"] }), { db: deps.db });
    expect(hosts).toContain("shop.example.com");
    expect(hosts).not.toContain("localhost");
  });
});

describe("the signals tick", () => {
  it("collects due lookups for brands with next_up, and nothing with its switch off", async () => {
    const { deps, clock } = setup();
    const s = await recordPosted(A, { ...ASK, market: { country: "US", language: "en" }, askedBy: "schedule", taskId: "aaaaaaaa-0001", cost: null }, deps);
    clock.t += FIRST_LOOK_MS;
    const listTenants = vi.fn(async () => [tenant()]);
    vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "false");
    expect(await runSignals({ deadlineMs: clock.t + 60_000 }, { ...deps, listTenants, clock: () => clock.t })).toEqual({ tenants: 0, ready: 0, failed: 0, waiting: 0 });
    expect(listTenants).not.toHaveBeenCalled();
    vi.stubEnv("SIGNALS_DATAFORSEO_ENABLED", "true");
    const judge = vi.fn(async () => ({ at: "2026-11-18T12:00:20.000Z", version: 1, items: [{ text: "How?", kind: "paa" as const, verdict: "use" as const, reason: "fits" }] }));
    expect(await runSignals({ deadlineMs: clock.t + 60_000 }, { ...deps, listTenants, clock: () => clock.t, judge })).toEqual({ tenants: 1, ready: 1, failed: 0, waiting: 0 });
    expect(await getSignal(A, s.id, deps)).toMatchObject({ status: "ready", judged: { items: [{ verdict: "use" }] } });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("starts no collect without enough time left, and skips brands without the feature", async () => {
    const { deps, clock, fetch } = setup();
    await recordPosted(A, { ...ASK, market: { country: "US", language: "en" }, askedBy: "schedule", taskId: "aaaaaaaa-0001", cost: null }, deps);
    clock.t += FIRST_LOOK_MS;
    expect(await runSignals({ deadlineMs: clock.t + 5_000 }, { ...deps, listTenants: async () => [tenant()], clock: () => clock.t })).toMatchObject({ ready: 0 });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "next_up");
    expect(await runSignals({ deadlineMs: clock.t + 60_000 }, { ...deps, listTenants: async () => [tenant({ grantedFeatures: [] })], clock: () => clock.t })).toMatchObject({ tenants: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
