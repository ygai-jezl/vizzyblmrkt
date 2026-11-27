import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { OPTION_PRESET } from "@/lib/types/recordField";
import { areaLabel, isRaiseReasonKey, RAISE_AREAS, RAISE_REASONS, RAISE_REASONS_VERSION, reasonOf, reasonsInArea } from "./reasons";

// The keys are counted over time: a rename would split one reason's count in two, so the list is pinned.
const PINNED = [
  "too_early",
  "retention",
  "unit_economics",
  "gtm_unclear",
  "market_small",
  "crowded",
  "timing",
  "product_unclear",
  "no_moat",
  "tech_risk",
  "team_gap",
  "price_terms",
  "round_size",
  "trading_history",
  "affordability",
  "not_thesis",
  "wrong_stage",
  "cheque_fit",
  "place",
  "conflict",
  "not_eligible",
  "no_reason",
  "other",
];

describe("the reason keys", () => {
  it("are exactly the 23 keys, in order, at version 1", () => {
    expect(RAISE_REASONS.map((r) => r.key)).toEqual(PINNED);
    expect(RAISE_REASONS_VERSION).toBe(1);
    expect(Object.isFrozen(RAISE_REASONS)).toBe(true);
  });

  it("sit under the 7 area chips in their order", () => {
    expect(RAISE_AREAS.map((a) => a.label)).toEqual(["Traction", "Market", "Product", "Team", "Deal", "Fit", "Other"]);
    const areas = RAISE_REASONS.map((r) => r.area);
    // Chip order: each key's area never comes before the one above it.
    const rank = (a: string) => RAISE_AREAS.findIndex((x) => x.key === a);
    for (let i = 1; i < areas.length; i++) expect(rank(areas[i]!)).toBeGreaterThanOrEqual(rank(areas[i - 1]!));
    expect(new Set(areas).size).toBe(7);
  });

  it("put a shop's lender keys under Deal and the grant key under Fit", () => {
    expect(RAISE_REASONS.filter((r) => r.audience === "lender").map((r) => [r.key, r.area])).toEqual([
      ["trading_history", "deal"],
      ["affordability", "deal"],
    ]);
    expect(reasonOf("not_eligible")).toMatchObject({ area: "fit", audience: "grant" });
  });

  it("are unique, fit the option marker and have short labels in house style", () => {
    expect(new Set(PINNED).size).toBe(23);
    for (const r of RAISE_REASONS) {
      expect(r.key).toMatch(OPTION_PRESET);
      expect(r.label.length, r.key).toBeLessThanOrEqual(60);
      expect(dashesIn(r.label), r.key).toEqual([]);
      expect(aiTellsIn(r.label), r.key).toEqual([]);
      expect(r.fixTo.length, r.key).toBeGreaterThan(0);
    }
  });

  it("are looked up by key, and put the given audiences first within an area", () => {
    expect(isRaiseReasonKey("crowded")).toBe(true);
    expect(isRaiseReasonKey("Crowded")).toBe(false);
    expect(reasonOf("nope")).toBeNull();
    expect(reasonOf(null)).toBeNull();
    expect(areaLabel("deal")).toBe("Deal");
    expect(reasonsInArea("deal").map((r) => r.key)).toEqual(["price_terms", "round_size", "trading_history", "affordability"]);
    expect(reasonsInArea("deal", ["lender", "grant"]).map((r) => r.key)).toEqual(["trading_history", "affordability", "price_terms", "round_size"]);
    expect(reasonsInArea("fit", ["lender", "grant"])[0]!.key).toBe("not_eligible");
  });
});
