import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { monthlyLimitWith } from "./limits";
import { addCounts, aiUsage, countedTowardCap, organisationUsageThisMonth, UNCAPPED_PURPOSES, usageMeter, usageThisMonth, usedThisMonth } from "./meter";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const NOV = () => new Date("2026-11-23T10:00:00.000Z");
const DEC = () => new Date("2026-12-01T00:00:01.000Z");
const brand = (over: Partial<Tenant> = {}) => ({ id: "ten_A", featureLimits: {}, ...over }) as unknown as Tenant;

beforeEach(() => {
  vi.stubEnv("USAGE_METER_ENABLED", "true");
  // Calls by purpose are kept only for the loops' heartbeat, while LOOPS_ENABLED is on.
  vi.stubEnv("LOOPS_ENABLED", "true");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the usage meter", () => {
  it("counts what each feature used this month, and starts again next month", async () => {
    const db = new FakeFirestore();
    await usageMeter(A, "web_searches", "blog_research", { db, now: NOV, tenant: brand() }).record(12);
    await usageMeter(A, "web_searches", "blog_research", { db, now: NOV, tenant: brand() }).record(8);
    await usageMeter(A, "web_searches", "brand_map_research", { db, now: NOV, tenant: brand() }).record(5);
    await usageMeter(A, "web_searches", "trending", { db, now: NOV, tenant: brand() }).record(0, { lost: true });
    expect((await usageThisMonth(A, { db, now: NOV })).web_searches).toEqual({
      total: 25,
      calls: 4,
      lostCalls: 1,
      byPurpose: { blog_research: 20, brand_map_research: 5 },
      callsByPurpose: { blog_research: 2, brand_map_research: 1, trending: 1 },
    });
    expect(await usedThisMonth(A, "web_searches", { db, now: DEC })).toBe(0);
    await usageMeter(A, "web_searches", "blog_research", { db, now: DEC, tenant: brand() }).record(3);
    expect(await usedThisMonth(A, "web_searches", { db, now: DEC })).toBe(3);
    expect(await usedThisMonth(A, "web_searches", { db, now: NOV })).toBe(25);
  });

  it("counts calls by purpose in the same write, and adds them up across brands (learning loops step 5)", async () => {
    const db = new FakeFirestore();
    await Promise.all(Array.from({ length: 3 }, () => usageMeter(A, "model_tokens", "blog_write", { db, now: NOV, tenant: brand() }).record(900)));
    await usageMeter(A, "model_tokens", "next_up", { db, now: NOV, tenant: brand() }).record(0, { lost: true });
    await usageMeter(B, "model_tokens", "blog_write", { db, now: NOV, tenant: brand({ id: "ten_B" } as Partial<Tenant>) }).record(400);
    // A call that spent nothing still counts as a use of its purpose.
    expect((await usageThisMonth(A, { db, now: NOV })).model_tokens?.callsByPurpose).toEqual({ blog_write: 3, next_up: 1 });
    expect((await organisationUsageThisMonth([A, B], { db, now: NOV }))?.model_tokens).toMatchObject({
      total: 3100,
      calls: 5,
      byPurpose: { blog_write: 3100 },
      callsByPurpose: { blog_write: 4, next_up: 1 },
    });
    // A month counted before calls by purpose adds as none, and a sum of two such months has none.
    const old = { total: 5, calls: 1, lostCalls: 0, byPurpose: { trending: 5 } };
    expect(addCounts(old, { ...old, callsByPurpose: { trending: 1 } }).callsByPurpose).toEqual({ trending: 1 });
    expect("callsByPurpose" in addCounts(old, old)).toBe(false);
  });

  it("keeps no calls by purpose with LOOPS_ENABLED off, so the meter's record is what it was", async () => {
    vi.stubEnv("LOOPS_ENABLED", "");
    const db = new FakeFirestore();
    await usageMeter(A, "model_tokens", "blog_write", { db, now: NOV, tenant: brand() }).record(900);
    const tokens = (await usageThisMonth(A, { db, now: NOV })).model_tokens;
    expect(tokens).toMatchObject({ total: 900, calls: 1, byPurpose: { blog_write: 900 } });
    expect(tokens).not.toHaveProperty("callsByPurpose");
  });

  it("adds up records made at the same time", async () => {
    const db = new FakeFirestore();
    await Promise.all(Array.from({ length: 6 }, () => usageMeter(A, "web_searches", "situation_questions", { db, now: NOV, tenant: brand() }).record(4)));
    expect((await usageThisMonth(A, { db, now: NOV })).web_searches).toMatchObject({ total: 24, calls: 6 });
  });

  it("stops at the brand's cap, and lets the call through below it", async () => {
    const db = new FakeFirestore();
    const capped = brand({ featureLimits: { web_searches: 10 } } as Partial<Tenant>);
    const meter = usageMeter(A, "web_searches", "blog_research", { db, now: NOV, tenant: capped });
    expect(await meter.check()).toBeNull();
    await meter.record(10);
    expect(await meter.check()).toEqual({ limited: true, used: 10, limit: 10 });
  });

  it("keeps one brand's count from another's", async () => {
    const db = new FakeFirestore();
    await usageMeter(A, "web_searches", "blog_research", { db, now: NOV, tenant: brand() }).record(7);
    expect(await usedThisMonth(B, "web_searches", { db, now: NOV })).toBe(0);
    await usageMeter(B, "web_searches", "blog_research", { db, now: NOV, tenant: brand({ id: "ten_B" } as Partial<Tenant>) }).record(2);
    expect(await usedThisMonth(A, "web_searches", { db, now: NOV })).toBe(7);
    expect((await organisationUsageThisMonth([A, B], { db, now: NOV }))?.web_searches).toMatchObject({ total: 9, calls: 2, byPurpose: { blog_research: 9 } });
  });

  it("never fails the work: a write or a read that fails is let go", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { collection: () => { throw new Error("down"); }, runTransaction: () => { throw new Error("down"); } } as never;
    const meter = usageMeter(A, "web_searches", "blog_research", { db: broken, now: NOV, tenant: brand() });
    await expect(meter.record(5)).resolves.toBeUndefined();
    await expect(meter.check()).resolves.toBeNull();
  });

  it("keeps model use by model, with dotted model ids as names, never paths", async () => {
    const db = new FakeFirestore();
    const usage = aiUsage(A, "blog_write", { db, now: NOV, tenant: brand() });
    await Promise.all([usage.recordModel(1200, "gemini-3.8-flash"), usage.recordModel(800, "gemini-3.8-flash"), usage.recordModel(500, "gemini-3.8-pro")]);
    await usage.recordModel(0, "gemini-3.8-flash", { lost: true });
    const m = await usageThisMonth(A, { db, now: NOV });
    expect(m.model_tokens).toEqual({
      total: 2500,
      calls: 4,
      lostCalls: 1,
      byPurpose: { blog_write: 2500 },
      callsByPurpose: { blog_write: 4 },
      byModel: { "gemini-3.8-flash": 2000, "gemini-3.8-pro": 500 },
    });
    // The stored doc nests the model id: no "gemini-3" map with an "8-flash" key inside it.
    const { forTenant } = await import("@/lib/tenant");
    const doc = await forTenant(A, db).usageMeters.getById("um_ten_A_2026-11");
    expect(Object.keys(doc?.meters.model_tokens?.byModel ?? {})).toEqual(["gemini-3.8-flash", "gemini-3.8-pro"]);
    expect(Object.keys(doc?.meters ?? {})).toEqual(["model_tokens"]);
    expect(doc?.tenantId).toBe("ten_A");
  });

  it("checks searches and images against their caps, and records each on its own meter", async () => {
    const db = new FakeFirestore();
    const capped = brand({ featureLimits: { images: 4, web_searches: 100 } } as Partial<Tenant>);
    const usage = aiUsage(A, "carousel", { db, now: NOV, tenant: capped });
    await usage.recordImages(1);
    await usage.recordImages(1);
    // A carousel of 3 slides would pass the cap of 4: it is refused before the first slide.
    expect(await usage.check("images", 3)).toEqual({ limited: true, used: 2, limit: 4 });
    expect(await usage.check("images", 2)).toBeNull();
    await usage.recordSearches(7);
    expect(await usage.check("searches")).toBeNull();
    const m = await usageThisMonth(A, { db, now: NOV });
    expect(m.images).toMatchObject({ total: 2, calls: 2, byPurpose: { carousel: 2 } });
    expect(m.web_searches).toMatchObject({ total: 7, byPurpose: { carousel: 7 } });
  });

  it("never caps model use or the older counters", async () => {
    const db = new FakeFirestore();
    const zero = brand({ featureLimits: { next_up: 0 } } as Partial<Tenant>);
    expect(await usageMeter(A, "model_tokens", "vizzy_chat", { db, now: NOV, tenant: zero }).check(1_000_000)).toBeNull();
    expect(await usageMeter(A, "google_lookups", "get_from_google", { db, now: NOV, tenant: zero }).check()).toBeNull();
  });

  it("never caps learning: loop_learn images are counted, kept off the cap and never checked (learning loops step 4)", async () => {
    const db = new FakeFirestore();
    const capped = brand({ featureLimits: { images: 2 } } as Partial<Tenant>);
    await aiUsage(A, "post_image", { db, now: NOV, tenant: capped }).recordImages(2);
    const learning = aiUsage(A, "loop_learn", { db, now: NOV, tenant: capped });
    expect(await learning.check("images")).toBeNull();
    await learning.recordImages(1);
    await learning.recordModel(900, "gemini-3.8-flash");
    expect(await usedThisMonth(A, "images", { db, now: NOV })).toBe(2);
    expect((await usageThisMonth(A, { db, now: NOV })).images).toMatchObject({ total: 3, byPurpose: { post_image: 2, loop_learn: 1 } });
    expect(await usageMeter(A, "images", "post_image", { db, now: NOV, tenant: capped }).check()).toEqual({ limited: true, used: 2, limit: 2 });
    expect(UNCAPPED_PURPOSES).toEqual(new Set(["loop_learn"]));
    expect(countedTowardCap(undefined)).toBe(0);
    expect(countedTowardCap({ total: 5, calls: 2, lostCalls: 0, byPurpose: { loop_learn: 9 } })).toBe(0);
  });

  it("refuses an id that isn't this brand's", async () => {
    const db = new FakeFirestore();
    const { forTenant } = await import("@/lib/tenant");
    await expect(forTenant(A, db).usageMeters.increment("um_ten_B_2026-11", { meters: { web_searches: { total: 1 } } })).rejects.toThrow();
    expect(await usedThisMonth(B, "web_searches", { db, now: NOV })).toBe(0);
  });

  it("with its switch off counts nothing and stops nothing", async () => {
    vi.stubEnv("USAGE_METER_ENABLED", "");
    const db = new FakeFirestore();
    const meter = usageMeter(A, "web_searches", "blog_research", { db, now: NOV, tenant: brand({ featureLimits: { web_searches: 0 } } as Partial<Tenant>) });
    await meter.record(9);
    expect(await meter.check()).toBeNull();
    expect(await usedThisMonth(A, "web_searches", { db, now: NOV })).toBe(0);
    // Nor calls by purpose: off, every view of them has nothing to read.
    expect(await usageThisMonth(A, { db, now: NOV })).toEqual({});
  });
});

describe("the web search cap", () => {
  const onPlan = (plan: string, over: Partial<Tenant> = {}) => ({ featureLimits: {}, orgPlan: plan, ...over }) as unknown as Tenant;

  it("comes from the brand, then Free or Pro, then this copy, then the default", () => {
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "web_searches=5000");
    expect(monthlyLimitWith(onPlan("free", { featureLimits: { web_searches: 40 } } as Partial<Tenant>), "web_searches", true)).toEqual({ limit: 40, from: "brand" });
    expect(monthlyLimitWith(onPlan("free"), "web_searches", true)).toEqual({ limit: 300, from: "plan" });
    expect(monthlyLimitWith(onPlan("pro"), "web_searches", true)).toEqual({ limit: 1500, from: "plan" });
    // Ultra sets no caps (decision 20): it follows this copy's.
    expect(monthlyLimitWith(onPlan("ultra"), "web_searches", true)).toEqual({ limit: 5000, from: "copy" });
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
    expect(monthlyLimitWith(onPlan("ultra"), "web_searches", true)).toEqual({ limit: 100_000, from: "default" });
    // Plans off: a self-hosted copy counts, and in practice never stops.
    expect(monthlyLimitWith(onPlan("free"), "web_searches", false)).toEqual({ limit: 100_000, from: "default" });
  });
});
