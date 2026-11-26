import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { LAYOUTS, pointsCap } from "./layouts";
import { AMOUNT_NEED, CORE_SECTIONS, DEFAULT_LAYOUT, OUTLINES, SECTION_BRIEF, guidanceFor, kindLabel, outlineFor } from "./outlines";
import { LAYOUT_KEYS, SECTION_KEYS } from "./types";
import { GUIDANCE, LENDER_GUIDANCE, SECTION_LABEL } from "./words";

const clean = (t: string) => [...dashesIn(t), ...aiTellsIn(t)];

describe("the outlines", () => {
  it("give a pre-seed deck 10 slides with Traction 4th, seed 12 and a lender pack 5", () => {
    expect(outlineFor("investor", "pre_seed").sections).toHaveLength(10);
    expect(outlineFor("investor", "pre_seed").sections[3]).toBe("traction");
    expect(outlineFor("investor", "seed").sections).toHaveLength(12);
    expect(outlineFor("lender", "loan").sections).toEqual(["cover", "sales", "use_of_funds", "repayment", "team"]);
    // A lender pack is always a loan, whatever stage is asked for.
    expect(outlineFor("lender", "seed").id).toBe("lender_loan");
    expect(kindLabel("investor", "seed")).toBe("Investor deck, seed");
    expect(kindLabel("lender", "loan")).toBe("Lender pack");
  });

  it("give every section a layout, a label, guidance and a brief, in house style", () => {
    for (const s of SECTION_KEYS) {
      expect(LAYOUT_KEYS).toContain(DEFAULT_LAYOUT[s]);
      expect(SECTION_LABEL[s], s).toBeTruthy();
      expect(GUIDANCE[s], s).toBeTruthy();
      expect(SECTION_BRIEF[s], s).toBeTruthy();
      expect(clean(`${SECTION_LABEL[s]} ${GUIDANCE[s]} ${SECTION_BRIEF[s]}`), s).toEqual([]);
    }
    for (const line of Object.values(LENDER_GUIDANCE)) expect(clean(line!)).toEqual([]);
    expect(guidanceFor("team", "lender")).toBe("What a lender looks for here: who runs the business day to day.");
    expect(guidanceFor("team", "investor")).toBe("What investors look for here: why you are the people to build it.");
  });

  it("keep every core section in its outline, and the amount Needs on the ask slides", () => {
    for (const s of CORE_SECTIONS.investor) expect(OUTLINES.investor_pre_seed.sections).toContain(s);
    for (const s of CORE_SECTIONS.lender) expect(OUTLINES.lender_loan.sections).toContain(s);
    expect(AMOUNT_NEED.ask).toBe("how much you're raising");
    expect(AMOUNT_NEED.use_of_funds).toBe("how much you want to borrow");
  });
});

describe("the layouts", () => {
  it("are all described, and a seed deck's product slide takes 4 points", () => {
    for (const k of LAYOUT_KEYS) expect(LAYOUTS[k].key).toBe(k);
    expect(pointsCap("three_points", "product", "seed")).toBe(4);
    expect(pointsCap("three_points", "product", "pre_seed")).toBe(3);
    expect(LAYOUTS.compare.compare).toBe(true);
    expect(LAYOUTS.team.people).toBe(4);
  });
});
