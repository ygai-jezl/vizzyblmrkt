import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/types/tenant";
import { brandMonthlyLimit, copyMonthlyLimits, DEFAULT_MONTHLY_LIMITS, LIMITED_FEATURES, monthlyLimit, monthlyLimitOf, monthlyLimitWith, parseLimitArg } from "./limits";
import { PLANS } from "./catalog";
import { withPlanCaps } from "./testing/planCaps";

const brand = (featureLimits?: Record<string, number>) => ({ featureLimits }) as Pick<Tenant, "featureLimits">;

describe("monthly caps", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the default when nothing else is set", () => {
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
    expect(monthlyLimitOf(null, "next_up")).toEqual({ limit: DEFAULT_MONTHLY_LIMITS.next_up, from: "default" });
    expect(monthlyLimit(brand(), "competitor_articles")).toBe(200);
  });

  it("takes the copy's setting over the default, and the brand's own cap over both", () => {
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "next_up=40, competitor_articles=300");
    expect(monthlyLimitOf(brand(), "next_up")).toEqual({ limit: 40, from: "copy" });
    expect(monthlyLimitOf(brand({ next_up: 150 }), "next_up")).toEqual({ limit: 150, from: "brand" });
    expect(monthlyLimit(brand({ next_up: 150 }), "competitor_articles")).toBe(300);
  });

  it("lets a brand's cap of 0 stop the feature", () => {
    expect(monthlyLimit(brand({ next_up: 0 }), "next_up")).toBe(0);
  });

  it("ignores parts of the setting that don't parse, and caps that are out of range", () => {
    expect(copyMonthlyLimits("next_up=abc,unknown=5,competitor_articles=-1,next_up=7")).toEqual({ next_up: 7 });
    expect(copyMonthlyLimits("next_up=1000000")).toEqual({});
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
    expect(monthlyLimitOf(brand({ next_up: 2.5 }), "next_up").from).toBe("default");
  });

  it("reads the brand record, and falls back when the read fails", async () => {
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "next_up=60");
    expect(await brandMonthlyLimit({ tenantId: "ten_A" }, "next_up", async () => brand({ next_up: 9 }) as Tenant)).toBe(9);
    expect(
      await brandMonthlyLimit({ tenantId: "ten_A" }, "next_up", async () => {
        throw new Error("down");
      }),
    ).toBe(60);
  });

  it("reads --limit for the grant script", () => {
    expect(parseLimitArg("150")).toBe(150);
    expect(parseLimitArg(" default ")).toBeNull();
    expect(parseLimitArg("0")).toBe(0);
    expect(parseLimitArg("-3")).toBe("invalid");
    expect(parseLimitArg("12.5")).toBe("invalid");
    expect(parseLimitArg("100001")).toBe("invalid");
  });
});

describe("monthly caps and plans", () => {
  afterEach(() => vi.unstubAllEnvs());

  const on = (orgPlan: unknown, featureLimits?: Record<string, number>) => ({ orgPlan, featureLimits }) as Pick<Tenant, "featureLimits" | "orgPlan">;

  it("ignores the plan with plans off, and never says it came from the plan", async () => {
    vi.stubEnv("PLANS_ENABLED", "false");
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
    // No plan sets a cap today, so Ultra gets one here: with plans off it still counts for nothing.
    await withPlanCaps("ultra", { article_autopilot: 4 }, () => {
      for (const p of PLANS) {
        for (const f of LIMITED_FEATURES) {
          expect(monthlyLimitOf(on(p.id), f)).toEqual({ limit: DEFAULT_MONTHLY_LIMITS[f], from: "default" });
        }
      }
      vi.stubEnv("FEATURE_MONTHLY_LIMITS", "article_autopilot=12");
      expect(monthlyLimitOf(on("ultra"), "article_autopilot")).toEqual({ limit: 12, from: "copy" });
      expect(monthlyLimit(on("ultra", { article_autopilot: 30 }), "article_autopilot")).toBe(30);
    });
  });

  it("with plans on: the brand's own cap, then the plan's, then the copy's, then the default", async () => {
    vi.stubEnv("PLANS_ENABLED", "true");
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "article_autopilot=12");
    await withPlanCaps("ultra", { article_autopilot: 4 }, () => {
      expect(monthlyLimitOf(on("ultra", { article_autopilot: 30 }), "article_autopilot")).toEqual({ limit: 30, from: "brand" });
      expect(monthlyLimitOf(on("ultra"), "article_autopilot")).toEqual({ limit: 4, from: "plan" });
    });
    expect(monthlyLimitOf(on("ultra"), "article_autopilot")).toEqual({ limit: 12, from: "copy" });
    expect(monthlyLimitOf(on(undefined), "article_autopilot")).toEqual({ limit: 12, from: "copy" });
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
    expect(monthlyLimitOf(on(undefined), "article_autopilot")).toEqual({ limit: DEFAULT_MONTHLY_LIMITS.article_autopilot, from: "default" });
  });

  it("falls through to the copy and the default on plans that set no cap", () => {
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "next_up=40");
    for (const plan of [...PLANS.map((p) => p.id), "platinum"]) {
      expect(monthlyLimitWith(on(plan), "next_up", true), plan).toEqual({ limit: 40, from: "copy" });
      expect(monthlyLimitWith(on(plan), "competitor_articles", true), plan).toEqual({ limit: 200, from: "default" });
      expect(monthlyLimitWith(on(plan), "article_autopilot", true), plan).toEqual({ limit: DEFAULT_MONTHLY_LIMITS.article_autopilot, from: "default" });
    }
  });

  it("ignores a plan cap that isn't a valid cap", async () => {
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
    for (const bad of [2.5, 1_000_000, -1]) {
      await withPlanCaps("ultra", { article_autopilot: bad }, () => {
        expect(monthlyLimitWith(on("ultra"), "article_autopilot", true), String(bad)).toEqual({ limit: DEFAULT_MONTHLY_LIMITS.article_autopilot, from: "default" });
      });
    }
    await withPlanCaps("ultra", { article_autopilot: 4 }, () => {
      expect(monthlyLimitWith(on("ultra"), "article_autopilot", true)).toEqual({ limit: 4, from: "plan" });
    });
    expect(PLANS.find((p) => p.id === "ultra")?.monthlyCaps).toEqual({});
  });

  it("reads the plan copy from the brand record", async () => {
    vi.stubEnv("PLANS_ENABLED", "true");
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
    await withPlanCaps("ultra", { article_autopilot: 4 }, async () => {
      expect(await brandMonthlyLimit({ tenantId: "ten_A" }, "article_autopilot", async () => on("ultra") as Tenant)).toBe(4);
      expect(await brandMonthlyLimit({ tenantId: "ten_A" }, "article_autopilot", async () => on("pro") as Tenant)).toBe(DEFAULT_MONTHLY_LIMITS.article_autopilot);
    });
  });
});
