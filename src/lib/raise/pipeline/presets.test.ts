import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { FIELD_LIMITS, FIELD_PRESET, FIELD_TYPES, hasOptions, OPTION_PRESET } from "@/lib/types/recordField";
import { RAISE_REASONS } from "@/lib/raise/reasons";
import {
  currencyFor,
  FIELD_PRESETS,
  fieldPreset,
  FUNDING_ONLY,
  isRaiseKit,
  kitFields,
  kitOptions,
  labelMatches,
  RAISE_CURRENCIES,
  RAISE_KITS,
  RAISE_PRESETS_VERSION,
  RAISING_ONLY,
  stageRole,
} from "./presets";

const labels = (o: readonly { label: string }[]) => o.map((x) => x.label);
const presets = (o: readonly { preset: string }[]) => o.map((x) => x.preset);

describe("the two kits", () => {
  it("make all ten fields, each with a fixed key and a type it can adopt", () => {
    expect(RAISE_PRESETS_VERSION).toBe(1);
    expect(RAISE_KITS).toEqual(["raising", "funding"]);
    expect(isRaiseKit("funding")).toBe(true);
    expect(isRaiseKit("loan")).toBe(false);
    for (const kit of RAISE_KITS) expect(kitFields(kit)).toBe(FIELD_PRESETS);
    expect(FIELD_PRESETS.map((f) => [f.preset, f.label, f.make])).toEqual([
      ["raise.relationship", "Relationship", "select"],
      ["raise.firm", "Firm", "text"],
      ["raise.tier", "Tier", "select"],
      ["raise.cheque", "Cheque", "currency"],
      ["raise.route_in", "Route in", "text"],
      ["raise.last_touch", "Last touch", "date"],
      ["raise.next_step", "Next step", "text"],
      ["raise.next_step_date", "Next step date", "date"],
      ["raise.stage", "Stage", "status"],
      ["raise.pass_reason", "Pass reason", "select"],
    ]);
    for (const f of FIELD_PRESETS) {
      expect(f.preset).toMatch(FIELD_PRESET);
      expect(f.adopt).toContain(f.make);
      for (const t of f.adopt) expect(FIELD_TYPES).toContain(t);
      expect(fieldPreset(f.preset)).toBe(f);
    }
    expect(fieldPreset("raise.nope")).toBeNull();
  });

  it("lay out the stages of each kit exactly as the plan has them", () => {
    expect(labels(kitOptions("raising", "raise.stage"))).toEqual([
      "Research",
      "Contacted",
      "Replied",
      "First meeting",
      "Next meeting",
      "Diligence",
      "Term sheet",
      "Committed (a promise)",
      "Money in",
      "Passed",
    ]);
    expect(labels(kitOptions("funding", "raise.stage"))).toEqual(["Plan", "Applied", "Decision", "Funds in", "Passed"]);
    expect(labels(kitOptions("raising", "raise.relationship"))).toEqual(["Investor", "Advisor", "Accelerator"]);
    // A plant shop's bank loan: Relationship gains Lender and Bank.
    expect(labels(kitOptions("funding", "raise.relationship"))).toEqual(["Investor", "Advisor", "Accelerator", "Lender", "Bank"]);
    expect(labels(kitOptions("funding", "raise.tier"))).toEqual(["A", "B", "C"]);
    expect(presets(kitOptions("raising", "raise.pass_reason"))).toEqual(RAISE_REASONS.map((r) => r.key));
    expect(kitOptions("raising", "raise.firm")).toEqual([]);
  });

  it("keep option labels short, in house style, unique and under the options cap", () => {
    for (const kit of RAISE_KITS) {
      for (const f of FIELD_PRESETS) {
        const opts = kitOptions(kit, f.preset);
        if (!hasOptions(f.make)) expect(opts).toEqual([]);
        expect(opts.length).toBeLessThanOrEqual(FIELD_LIMITS.options);
        expect(new Set(presets(opts)).size).toBe(opts.length);
        for (const o of opts) {
          expect(o.preset).toMatch(OPTION_PRESET);
          for (const l of [o.label, ...o.aliases]) {
            expect(l.length).toBeLessThanOrEqual(FIELD_LIMITS.labelChars);
            expect(dashesIn(l)).toEqual([]);
            expect(aiTellsIn(l)).toEqual([]);
          }
        }
      }
    }
    for (const f of FIELD_PRESETS) for (const l of [f.label, ...f.aliases]) expect(dashesIn(l)).toEqual([]);
  });

  it("give each stage a role, and a team's own option is in play", () => {
    expect(stageRole("research")).toBe("open");
    expect(stageRole("plan")).toBe("open");
    expect(stageRole("contacted")).toBe("active");
    expect(stageRole("decision")).toBe("active");
    expect(stageRole("money_in")).toBe("won");
    expect(stageRole("funds_in")).toBe("won");
    expect(stageRole("passed")).toBe("passed");
    expect(stageRole(null)).toBe("active");
    expect([...RAISING_ONLY]).not.toContain("passed");
    expect([...FUNDING_ONLY]).toEqual(["plan", "applied", "decision", "funds_in"]);
  });

  it("match a team's own name, case insensitive and trimmed", () => {
    const committed = kitOptions("raising", "raise.stage").find((o) => o.preset === "committed")!;
    expect(labelMatches(" committed ", committed)).toBe(true);
    expect(labelMatches("Committed (a promise)", committed)).toBe(true);
    expect(labelMatches("Commit", committed)).toBe(false);
    expect(labelMatches("valuation", kitOptions("raising", "raise.pass_reason").find((o) => o.preset === "price_terms")!)).toBe(true);
  });
});

describe("currencyFor", () => {
  it.each([
    ["Europe/London", "GBP"],
    ["Europe/Paris", "EUR"],
    ["America/New_York", "USD"],
    ["America/Toronto", "CAD"],
    ["Australia/Sydney", "AUD"],
    ["Pacific/Auckland", "NZD"],
    ["Asia/Kolkata", "INR"],
    ["Asia/Singapore", "SGD"],
    ["Asia/Tokyo", "USD"],
    [null, "USD"],
    ["", "USD"],
  ])("%s is %s", (tz, code) => {
    expect(currencyFor(tz)).toBe(code);
  });

  it("only ever answers a currency the choice offers", () => {
    for (const tz of ["Europe/London", "Europe/Berlin", "America/Chicago", "America/Vancouver", "Australia/Perth", "Africa/Lagos"]) {
      expect(RAISE_CURRENCIES).toContain(currencyFor(tz) as (typeof RAISE_CURRENCIES)[number]);
    }
  });
});
