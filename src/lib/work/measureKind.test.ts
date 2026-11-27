import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { reasonProblems } from "@/lib/loops/reason";
import { proposedByRule, suggestMeasureKind, type MeasureKindInput } from "./measureKind";
import { ProposedKindSchema, WORK_LIMITS } from "./types";

const kind = (input: MeasureKindInput) => suggestMeasureKind(input)?.kind ?? null;

describe("the suggested kind of win", () => {
  it("is Done is the win for Set up, Billing and tax, and legal or compliance work", () => {
    expect(kind({ title: "Buy the domain", stage: "set_up" })).toBe("done");
    expect(kind({ title: "Pick an accountant", stage: "billing_tax" })).toBe("done");
    expect(kind({ title: "SOC 2 type 1" })).toBe("done");
    expect(kind({ title: "Van insurance" })).toBe("done");
    expect(kind({ title: "Register the business" })).toBe("done");
    expect(kind({ title: "Update the privacy policy", brandId: "ten_lumen" })).toBe("done");
  });

  it("is Runs better for a bug, crash, error, memory, security, cost or speed task", () => {
    expect(kind({ title: "Fix the crash on note export", brandId: "ten_lumen" })).toBe("runs_better");
    expect(kind({ title: "Memory climbs during the nightly run" })).toBe("runs_better");
    expect(kind({ title: "Cut hosting costs" })).toBe("runs_better");
    expect(kind({ title: "Search is slow", description: "Takes 4s on big notebooks" })).toBe("runs_better");
    expect(kind({ title: "A bug in the registration form" })).toBe("runs_better");
  });

  it("is Used for a task that links a switch, and Moves a number for a brand or an idea", () => {
    const sw = { kind: "switch", name: "CREATE_SUGGEST_ANGLE_ENABLED" } as const;
    expect(kind({ title: "Suggest an angle", typedLinks: [sw], brandId: "ten_lumen" })).toBe("used");
    expect(kind({ title: "Suggest an angle", typedLinks: [{ kind: "switch", none: "No switch." }], brandId: "ten_lumen" })).toBe("moves");
    expect(kind({ title: "Market stall on Saturdays", brandId: "ten_fernhill" })).toBe("moves");
    expect(kind({ title: "Market stall on Saturdays", ideaId: "cmp_stall" })).toBe("moves");
    expect(kind({ title: "Market stall on Saturdays" })).toBeNull();
    // In a one brand organisation every task counts as the brand's.
    expect(kind({ title: "Market stall on Saturdays", oneBrand: true })).toBe("moves");
    // A whole business task in a multi brand organisation that serves an idea under Connected to.
    const served = suggestMeasureKind({ title: "Plan the spring stall", brandId: null, ideaId: null, oneBrand: false, typedLinks: [{ kind: "idea", brandId: "b1", ideaId: "i1" }], ideaWords: true });
    expect(served).toEqual({ kind: "moves", reason: "It serves an idea, so the win is a number that moves for it." });
  });

  it("takes the first match: Done is the win, then Runs better, then Used, then Moves a number", () => {
    const sw = { kind: "switch", name: "X_ENABLED" } as const;
    expect(kind({ title: "Fix the crash", stage: "set_up", typedLinks: [sw], brandId: "b" })).toBe("done");
    expect(kind({ title: "Fix the crash", typedLinks: [sw], brandId: "b" })).toBe("runs_better");
    expect(kind({ title: "New editor", typedLinks: [sw], brandId: "b" })).toBe("used");
  });

  it("gives a reason in house style that fits the proposal, marked as the rule's", () => {
    const inputs: MeasureKindInput[] = [
      { title: "x", stage: "set_up" },
      { title: "x", stage: "billing_tax" },
      { title: "Trademark" },
      { title: "Fix a bug" },
      { title: "x", typedLinks: [{ kind: "switch", name: "X_ENABLED" }] },
      { title: "x", ideaId: "cmp_1" },
      { title: "x", typedLinks: [{ kind: "idea", brandId: "b1", ideaId: "i1" }], ideaWords: true },
      { title: "x", brandId: "b" },
    ];
    for (const i of inputs) {
      const s = suggestMeasureKind(i)!;
      expect(s.reason.length, s.reason).toBeLessThanOrEqual(WORK_LIMITS.proposedReason);
      expect(reasonProblems(s.reason), s.reason).toEqual([]);
      expect([...dashesIn(s.reason), ...aiTellsIn(s.reason)]).toEqual([]);
      const p = proposedByRule(i)!;
      expect(p.by).toBe("rule");
      expect(ProposedKindSchema.safeParse(p).success).toBe(true);
    }
    expect(proposedByRule({ title: "Saturday stall" })).toBeNull();
  });
});
