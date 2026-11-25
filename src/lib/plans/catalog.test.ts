import { describe, expect, it } from "vitest";
import { FEATURE_NEEDS, METERED_FEATURES } from "./brandAccess";
import { DEFAULT_MONTHLY_LIMITS, LIMITED_FEATURES, MAX_MONTHLY_LIMIT, LIMITED_RESOURCES, isLimitedResource } from "./limits";
import {
  ALLOWANCES,
  ALLOWANCE_LABELS,
  ALLOWANCE_LABELS_AS_IDEAS,
  allowanceLabels,
  EE_FEATURES,
  FEATURE_LABELS,
  INCLUDED_IN_EVERY_PLAN,
  PLANS,
  allowanceLimit,
  allowanceText,
  newBrandPlanNote,
  planById,
  planSummary,
  type Plan,
  type PlanFeature,
} from "./catalog";
import { ENTERPRISE_FEATURE_IDS } from "@/lib/enterprise/features";
import { PLAN_IDS } from "@/lib/types/organisation";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";

const plan = (id: string): Plan => planById(id)!;
/** The hosted ladder, from the smallest plan up. */
const LADDER = ["free", "pro", "ultra", "enterprise"].map(plan);
const pairs = LADDER.slice(1).map((higher, i) => [LADDER[i]!, higher] as const);
/** null is no limit, so it counts as the highest. */
const rank = (n: number | null) => (n === null ? Number.POSITIVE_INFINITY : n);

describe("plan catalog", () => {
  it("has exactly the five plans, in ladder order", () => {
    expect(PLANS.map((p) => p.id)).toEqual([...PLAN_IDS]);
    expect(PLAN_IDS).toEqual(["self_hosted", "free", "pro", "ultra", "enterprise"]);
  });

  it("keeps Self-hosted open: every metered feature, no Enterprise feature, no limits and no caps", () => {
    const self = plan("self_hosted");
    for (const f of METERED_FEATURES) expect(self.features).toContain(f);
    for (const f of EE_FEATURES) expect(self.features).not.toContain(f);
    expect(Object.values(self.allowances).every((v) => v === null)).toBe(true);
    expect(self.monthlyCaps).toEqual({});
    expect(self.hosted).toBe(false);
  });

  it("takes the Enterprise features from the licence list", () => {
    expect(EE_FEATURES).toEqual(ENTERPRISE_FEATURE_IDS);
    expect(EE_FEATURES).toHaveLength(8);
    for (const f of EE_FEATURES) expect(plan("enterprise").features).toContain(f);
    for (const p of PLANS.filter((x) => x.id !== "enterprise")) for (const f of EE_FEATURES) expect(p.features).not.toContain(f);
  });

  it("follows the signed off tiers table", () => {
    expect(plan("free").allowances).toEqual({ brands: 1, users: 2, liveIdeas: 1, people: 1000, emailsPerMonth: 1000, aiCreditsPerMonth: 50 });
    expect(plan("pro").allowances).toEqual({ brands: 3, users: null, liveIdeas: 5, people: 10000, emailsPerMonth: 5000, aiCreditsPerMonth: 250 });
    expect(plan("ultra").allowances).toEqual({ brands: 10, users: null, liveIdeas: null, people: 100000, emailsPerMonth: 50000, aiCreditsPerMonth: 1200 });
    // Talk with Vizzy by voice is in every plan.
    expect(plan("free").features).toEqual(["onboarding_voice"]);
    expect([...plan("pro").features].sort()).toEqual(["brand_search", "edit_vizzy", "onboarding_voice"]);
    expect([...plan("ultra").features].sort()).toEqual([...METERED_FEATURES].sort());
    // Free and Pro cap web searches for research; Ultra sets no caps (decision 20), Enterprise by agreement.
    expect(plan("free").monthlyCaps).toEqual({ web_searches: 300 });
    expect(plan("pro").monthlyCaps).toEqual({ web_searches: 1500 });
    for (const id of ["self_hosted", "ultra", "enterprise"] as const) expect(plan(id).monthlyCaps, id).toEqual({});
    expect(PLANS.map((p) => p.pricePerUserMonthUsd)).toEqual([0, 0, 9, 35, null]);
  });

  it("gives AI credits per organisation on Free and per user on Pro and Ultra", () => {
    expect(plan("free").perUser).toEqual([]);
    expect(plan("pro").perUser).toEqual(["aiCreditsPerMonth"]);
    expect(plan("ultra").perUser).toEqual(["aiCreditsPerMonth"]);
    expect(allowanceLimit(plan("free"), "aiCreditsPerMonth", 2)).toBe(50);
    expect(allowanceLimit(plan("pro"), "aiCreditsPerMonth", 2)).toBe(500);
    expect(allowanceLimit(plan("ultra"), "aiCreditsPerMonth", 3)).toBe(3600);
    expect(allowanceLimit(plan("pro"), "aiCreditsPerMonth", 0)).toBe(250);
    expect(allowanceLimit(plan("pro"), "aiCreditsPerMonth")).toBe(250);
    expect(allowanceLimit(plan("pro"), "people", 5)).toBe(10000);
    expect(allowanceLimit(plan("enterprise"), "aiCreditsPerMonth", 5)).toBeNull();
  });

  it("writes allowances the way the tiers table does", () => {
    expect(allowanceText(plan("pro"), "aiCreditsPerMonth")).toBe("250 per user");
    expect(allowanceText(plan("ultra"), "aiCreditsPerMonth")).toBe("1,200 per user");
    expect(allowanceText(plan("free"), "people")).toBe("1,000");
    expect(allowanceText(plan("pro"), "users")).toBe("No limit");
    expect(allowanceText(plan("enterprise"), "people")).toBe("Custom");
    expect(allowanceText(plan("self_hosted"), "emailsPerMonth")).toBe("Your email provider");
    expect(allowanceText(plan("self_hosted"), "brands")).toBe("No limit");
  });

  it("never takes a feature away from Free to Pro to Ultra to Enterprise", () => {
    for (const [lower, higher] of pairs) for (const f of lower.features) expect(higher.features, `${lower.id} -> ${higher.id}`).toContain(f);
  });

  it("never lowers an allowance up the ladder", () => {
    for (const [lower, higher] of pairs) {
      for (const a of ALLOWANCES) expect(rank(higher.allowances[a]), `${a}: ${lower.id} -> ${higher.id}`).toBeGreaterThanOrEqual(rank(lower.allowances[a]));
    }
  });

  it("never lowers a cap up the ladder (an unset cap is the default)", () => {
    for (const [lower, higher] of pairs) {
      for (const f of LIMITED_FEATURES) {
        if (!lower.features.includes(f) || !higher.features.includes(f)) continue;
        const capOf = (p: Plan) => p.monthlyCaps[f] ?? DEFAULT_MONTHLY_LIMITS[f];
        expect(capOf(higher), `${f}: ${lower.id} -> ${higher.id}`).toBeGreaterThanOrEqual(capOf(lower));
      }
    }
  });

  it("never promises in a summary a feature the plan can't reach without what it needs", () => {
    for (const p of PLANS) {
      for (const [f, needs] of Object.entries(FEATURE_NEEDS)) {
        if (p.features.includes(f as PlanFeature) && !p.features.includes(needs as PlanFeature)) {
          expect(p.summary.toLowerCase(), `${p.id}: ${f}`).not.toContain(FEATURE_LABELS[f as PlanFeature].toLowerCase());
        }
      }
    }
    expect(plan("pro").summary).not.toMatch(/autopilot/i);
  });

  it("keeps the features that need another together", () => {
    const needs: Array<[PlanFeature, PlanFeature]> = [
      ["competitor_articles", "competitors"],
      ["edit_vizzy_learning", "edit_vizzy"],
      // The autopilot drafts the top of Next up, so it is on Ultra only (2026-11-20).
      ["article_autopilot", "next_up"],
    ];
    for (const [f, base] of Object.entries(FEATURE_NEEDS)) expect(needs).toContainEqual([f, base]);
    for (const p of PLANS) for (const [f, base] of needs) if (p.features.includes(f)) expect(p.features, `${p.id}: ${f}`).toContain(base);
    expect(plan("pro").features).not.toContain("article_autopilot");
    expect(plan("ultra").features).toContain("article_autopilot");
  });

  it("sets caps only for limited features the plan includes, or paid resources, within the most a cap may be", () => {
    for (const p of PLANS) {
      for (const [f, cap] of Object.entries(p.monthlyCaps)) {
        if (isLimitedResource(f)) {
          // A resource is used by every feature: no grant, so no feature to include.
        } else {
          expect(LIMITED_FEATURES as readonly string[]).toContain(f);
          expect(p.features).toContain(f);
        }
        expect(Number.isInteger(cap) && cap! >= 0 && cap! <= MAX_MONTHLY_LIMIT).toBe(true);
      }
    }
  });

  it("never lowers a resource's cap up the ladder", () => {
    const ladder = ["free", "pro", "ultra"] as const;
    for (const r of LIMITED_RESOURCES) {
      // A plan with no cap of its own follows this copy's cap, which is at least any plan's.
      const caps = ladder.map((id) => plan(id).monthlyCaps[r] ?? Infinity);
      for (let i = 1; i < caps.length; i += 1) expect(caps[i]!, `${r}: ${ladder[i]}`).toBeGreaterThanOrEqual(caps[i - 1]!);
    }
  });

  it("works out which features every plan includes", () => {
    const common = [...METERED_FEATURES, ...EE_FEATURES].filter((f) => PLANS.every((p) => p.features.includes(f)));
    expect([...INCLUDED_IN_EVERY_PLAN].sort()).toEqual(common.sort());
    expect(INCLUDED_IN_EVERY_PLAN).toEqual(["onboarding_voice"]);
  });

  it("labels every feature and allowance, in house style", () => {
    for (const f of [...METERED_FEATURES, ...EE_FEATURES]) expect(FEATURE_LABELS[f]).toBeTruthy();
    for (const a of ALLOWANCES) expect(ALLOWANCE_LABELS[a]).toBeTruthy();
    const copy = [
      ...PLANS.flatMap((p) => [p.name, p.summary, p.summaryAsIdeas ?? "", ...Object.values(p.allowanceNotes)]),
      ...Object.values(FEATURE_LABELS),
      ...Object.values(ALLOWANCE_LABELS),
      ...Object.values(ALLOWANCE_LABELS_AS_IDEAS),
    ];
    for (const text of copy) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });

  it("names live ideas, and Free's one live launch, in the words in use", () => {
    expect(allowanceLabels(false)).toBe(ALLOWANCE_LABELS);
    expect(allowanceLabels(false).liveIdeas).toBe("Live launches");
    expect(allowanceLabels(true).liveIdeas).toBe("Live ideas");
    expect({ ...allowanceLabels(true), liveIdeas: "" }).toEqual({ ...ALLOWANCE_LABELS, liveIdeas: "" });
    const free = planById("free")!;
    expect(planSummary(free, false)).toBe("One brand and one live launch, to try YouGrow with a small team.");
    expect(planSummary(free, true)).toBe("One brand and one live idea, to try YouGrow with a small team.");
    for (const p of PLANS) {
      expect(planSummary(p, true), p.id).not.toMatch(/\blaunch/i);
      if (!p.summaryAsIdeas) expect(planSummary(p, true)).toBe(p.summary);
    }
  });

  it("says which plan a new brand starts on, in house style", () => {
    expect(newBrandPlanNote(plan("self_hosted"))).toBe(
      "This brand starts on its own plan, Self-hosted. To put it on one plan with your other brands, ask whoever runs your copy of YouGrow.",
    );
    for (const p of PLANS) {
      const text = newBrandPlanNote(p);
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });

  it("finds no plan for anything else", () => {
    expect(planById("nope")).toBeNull();
    expect(planById("")).toBeNull();
    expect(planById(undefined)).toBeNull();
    expect(planById("__proto__")).toBeNull();
    expect(planById("Ultra")).toBeNull();
    expect(planById("ultra")?.name).toBe("Ultra");
  });
});
