import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/types/tenant";
import { brandMonthlyLimit, copyMonthlyLimits, DEFAULT_MONTHLY_LIMITS, monthlyLimit, monthlyLimitOf, parseLimitArg } from "./limits";

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
