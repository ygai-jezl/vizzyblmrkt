import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RAISE_REASONS } from "@/lib/raise/reasons";
import { PASS_WORDS } from "@/lib/raise/pipeline/words";
import type { ReasonChoice } from "./investorsApi";
import { areasWithReasons, PassReasonDialog, reasonChips } from "./PassReasonDialog";

// A brand set up with every ready-made reason, plus one of its own.
const ALL: ReasonChoice[] = [
  ...RAISE_REASONS.map((r, i) => ({ optionId: `opt_reason${String(i).padStart(3, "0")}`, label: r.label, key: r.key, area: r.area })),
  { optionId: "opt_lead0001", label: "Wants a lead first", key: null, area: "other" },
];
const keys = (chips: ReasonChoice[]) => chips.map((c) => c.key ?? c.label);

describe("Why did they pass?", () => {
  it("offers the seven areas in order, each with its own reasons", () => {
    expect(areasWithReasons(ALL, false).map((a) => a.label)).toEqual(["Traction", "Market", "Product", "Team", "Deal", "Fit", "Other"]);
    expect(keys(reasonChips(ALL, "traction", false))).toEqual(["too_early", "retention", "unit_economics", "gtm_unclear"]);
    expect(keys(reasonChips(ALL, "deal", false))).toEqual(["price_terms", "round_size", "trading_history", "affordability"]);
  });

  it("puts a lender's reasons first under Deal and a grant's under Fit on a Funding board", () => {
    expect(keys(reasonChips(ALL, "deal", true))).toEqual(["trading_history", "affordability", "price_terms", "round_size"]);
    expect(keys(reasonChips(ALL, "fit", true))[0]).toBe("not_eligible");
  });

  it("puts the team's own reasons under Other, after the ready-made ones", () => {
    expect(keys(reasonChips(ALL, "other", false))).toEqual(["no_reason", "other", "Wants a lead first"]);
  });

  it("leaves out reasons the brand doesn't hold, and areas with none", () => {
    const some = ALL.filter((o) => o.key === "crowded" || o.key === null);
    expect(areasWithReasons(some, false).map((a) => a.key)).toEqual(["market", "other"]);
    expect(reasonChips(some, "traction", false)).toEqual([]);
  });

  it("shows the line, the chips of the open area and the three buttons", () => {
    const html = renderToStaticMarkup(createElement(PassReasonDialog, { options: ALL, funding: false, onSave: () => {}, onCancel: () => {}, initialArea: "other" })).replace(/&#x27;/g, "'");
    expect(html).toContain(PASS_WORDS.title);
    expect(html).toContain(PASS_WORDS.line);
    expect(html).toContain(PASS_WORDS.ownReasons);
    expect(html).toContain("Wants a lead first");
    for (const b of [PASS_WORDS.save, PASS_WORDS.blank, PASS_WORDS.cancel]) expect(html).toContain(b);
    // Save waits for a reason.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });
});
