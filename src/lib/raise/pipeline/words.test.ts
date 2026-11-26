import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { AGENT_NOT_SET_UP, AGENT_NOTE, BOARD_WORDS, NOUNS, PASS_WORDS, REVIEW_WORDS, ROLE_WORDS, SETUP_WORDS, setupMessage, TIMELINE_WORDS } from "./words";

/** Every string in a words object, with each function called on made-up values. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") {
    const fn = value as (...a: unknown[]) => unknown;
    for (const args of [
      [3, 2, 1, 14],
      ["Stage", "text", true, "select or status"],
      ["Stage", "text", false, "select"],
      ["2026-12-03"],
      [null],
      [1, 0, 0, 14],
    ]) {
      try {
        strings(fn(...args), out);
      } catch {
        // A function that wants other arguments: the next set.
      }
    }
  } else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

describe("the board's words", () => {
  const all = strings([SETUP_WORDS, BOARD_WORDS, PASS_WORDS, REVIEW_WORDS, TIMELINE_WORDS, NOUNS, ROLE_WORDS, AGENT_NOTE, AGENT_NOT_SET_UP]);

  it("keep to house style: no dashes as punctuation, no AI tells", () => {
    expect(all.length).toBeGreaterThan(60);
    for (const s of all) {
      expect(dashesIn(s), s).toEqual([]);
      expect(aiTellsIn(s), s).toEqual([]);
    }
  });

  it("say the counts line for both boards", () => {
    expect(BOARD_WORDS.counts("raising", 31, 5, 2, 14)).toBe("31 investors, 5 quiet for 14 days, 2 past their next step date");
    expect(BOARD_WORDS.counts("raising", 1, 0, 0, 14)).toBe("1 investor, 0 quiet for 14 days");
    expect(BOARD_WORDS.counts("funding", 4, 1, 0, 14)).toBe("4 lenders and funders, 1 quiet for 14 days");
    expect(BOARD_WORDS.counts("funding", 1, 0, 1, 14)).toBe("1 lender or funder, 0 quiet for 14 days, 1 past their next step date");
  });

  it("word a card's dates and days", () => {
    expect(BOARD_WORDS.nextStep("2026-12-03")).toBe("Next step 3 Dec 2026");
    expect(BOARD_WORDS.nextStepWas("2026-12-03")).toBe("Next step was 3 Dec 2026");
    expect(BOARD_WORDS.quietFor(16)).toBe("Quiet for 16 days");
    expect(BOARD_WORDS.tier("A")).toBe("Tier A");
  });

  it("word a press, at most 200 characters", () => {
    expect(setupMessage("raising", { fields: 10, options: 39 }, [])).toBe("Set up for raising: added 10 fields and 39 options");
    expect(setupMessage("raising", { fields: 9, options: 7 }, ["Stage"])).toBe("Set up for raising: added 9 fields and 7 options, and used your Stage");
    expect(setupMessage("funding", { fields: 0, options: 6 }, ["Stage", "Relationship"])).toBe("Set up for funding: added 0 fields and 6 options, and used your Stage and Relationship");
    expect(setupMessage("raising", { fields: 0, options: 0 }, ["Stage"])).toBe("Set up for raising: used your Stage");
    expect(setupMessage("raising", { fields: 1, options: 1 }, Array.from({ length: 9 }, () => "x".repeat(60))).length).toBeLessThanOrEqual(200);
  });

  it("word Review's rows with only the stage's name", () => {
    expect(REVIEW_WORDS.quietTitle(16)).toBe("Quiet for 16 days");
    expect(REVIEW_WORDS.quietDetail("Contacted")).toBe("In Contacted. Open their page to follow up.");
    expect(REVIEW_WORDS.nextStepDetail("First meeting")).toBe("In First meeting. Open their page to set the next step.");
    expect(REVIEW_WORDS.nextStepDetail(null)).toBe("Open their page to set the next step.");
  });
});
