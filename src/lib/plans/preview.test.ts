import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "@/lib/types/tenant";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { METERED_FEATURES } from "./brandAccess";
import { DEFAULT_MONTHLY_LIMITS } from "./limits";
import { EXCLUDED_EFFECT, accessChangeLines, accessChanges } from "./preview";

type Fields = Pick<Tenant, "grantedFeatures" | "featureLimits" | "orgPlan">;
const brand = (over: Partial<Fields> = {}): Fields => ({ grantedFeatures: [], ...over });

describe("plan change previews", () => {
  beforeEach(() => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "");
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "");
    // Previews always work with plans on, whatever the switch says.
    vi.stubEnv("PLANS_ENABLED", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lists what a brand with no plan loses on Free, with what each hides", () => {
    const c = accessChanges(brand(), "free");
    const lost = c.features.filter((f) => f.before && !f.after).map((f) => f.feature);
    expect(lost).toEqual(expect.arrayContaining(["next_up", "competitors"]));
    expect(lost.sort()).toEqual([...METERED_FEATURES].sort());
    expect(c.features.find((f) => f.feature === "competitors")?.hidden).toBe(EXCLUDED_EFFECT.competitors);
    expect(c.features.find((f) => f.feature === "next_up")?.hidden).toBe(EXCLUDED_EFFECT.next_up);
    expect(c.narrower).toBe(true);
    expect(c.wider).toBe(false);
  });

  it("changes nothing for a brand with no plan moved to Ultra", () => {
    const c = accessChanges(brand(), "ultra");
    expect(c).toEqual({ features: [], caps: [], narrower: false, wider: false });
    expect(accessChangeLines(c)).toEqual([]);
  });

  it("changes nothing with the copy's caps set, or own grants and caps, moved to Ultra", () => {
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "next_up=40,article_autopilot=20");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "edit_vizzy_learning");
    const c = accessChanges(brand({ grantedFeatures: ["edit_vizzy_learning"], featureLimits: { article_autopilot: 45 } }), "ultra");
    expect(c.narrower).toBe(false);
    expect(c.wider).toBe(false);
  });

  it("lists raised caps and gained features as wider (Pro to Ultra)", () => {
    const c = accessChanges(brand({ orgPlan: "pro" }), "ultra");
    expect(c.features.filter((f) => f.after).map((f) => f.feature).sort()).toEqual(["competitor_articles", "competitors", "edit_vizzy_learning", "next_up"]);
    expect(c.caps).toEqual([{ feature: "article_autopilot", before: 4, after: DEFAULT_MONTHLY_LIMITS.article_autopilot, beforeFrom: "plan", afterFrom: "default" }]);
    expect(c.wider).toBe(true);
    expect(c.narrower).toBe(false);
    expect(accessChangeLines(c)).toContain("article_autopilot cap raised from 4 to 8 a month (from the default)");
  });

  it("lists a cap that drops from the copy's setting to a lower plan cap as narrower", () => {
    vi.stubEnv("FEATURE_MONTHLY_LIMITS", "article_autopilot=10");
    // Grants keep the features Pro lacks, so only the cap changes.
    const c = accessChanges(brand({ orgPlan: "ultra", grantedFeatures: ["next_up", "competitors", "competitor_articles", "edit_vizzy_learning"] }), "pro");
    expect(c.features).toEqual([]);
    expect(c.caps).toEqual([{ feature: "article_autopilot", before: 10, after: 4, beforeFrom: "copy", afterFrom: "plan" }]);
    expect(c.narrower).toBe(true);
    expect(c.wider).toBe(false);
    expect(accessChangeLines(c)).toEqual(["article_autopilot cap lowered from 10 to 4 a month (from the plan's cap)"]);
  });

  it("keeps a granted feature and a brand's own cap whatever the plan", () => {
    const c = accessChanges(brand({ grantedFeatures: ["competitors"], featureLimits: { article_autopilot: 2 } }), "pro");
    expect(c.features.map((f) => f.feature)).not.toContain("competitors");
    expect(c.caps).toEqual([]);
  });

  it("never counts a held back feature the brand isn't granted", () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitors");
    expect(accessChanges(brand({ orgPlan: "free" }), "ultra").features.map((f) => f.feature)).not.toContain("competitors");
  });

  it("shows taking a plan away as wider", () => {
    const c = accessChanges(brand({ orgPlan: "free" }), null);
    expect(c.wider).toBe(true);
    expect(c.narrower).toBe(false);
    expect(accessChangeLines(c)[0]).toBe("gains Vizzy in Edit mode (edit_vizzy)");
  });

  it("writes every hidden data line in house style", () => {
    for (const line of Object.values(EXCLUDED_EFFECT)) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
    expect(accessChangeLines(accessChanges(brand(), "free"))[0]).toMatch(/^loses .+ \(.+\): .+ kept\.$/);
  });
});
