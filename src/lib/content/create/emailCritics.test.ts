import { describe, it, expect } from "vitest";
import { spamScan, fleschKincaidGrade, collapseBangs } from "./emailCritics";

describe("emailCritics", () => {
  it("flags spam phrases and shouting in subject + body", () => {
    const r = spamScan("BUY NOW", "<p>CLICK HERE for FREE CASH now.</p>");
    expect(r.warnings).toContain("spam_subject");
    expect(r.warnings).toContain("spam_body");
  });

  it("does not flag ordinary incentive copy like 'free shipping'", () => {
    const r = spamScan("Your order update", "<p>Enjoy free shipping on your next order.</p>");
    expect(r.warnings).toEqual([]);
  });

  it("does not flag copy that is merely acronym-heavy", () => {
    const r = spamScan("Our SAAS update", "<p>Read the FAQ and TERMS. NASA and IKEA use our API.</p>");
    expect(r.warnings).toEqual([]);
  });

  it("collapses runs of exclamation marks (the one safe auto-fix)", () => {
    expect(collapseBangs("Wow!!! Really?? Yes!!")).toBe("Wow! Really?? Yes!");
    const r = spamScan("Limited spots left!!!", "<p>Grab yours.</p>");
    expect(r.cleanedSubject).toBe("Limited spots left!");
  });

  it("scores simple copy low and dense copy high", () => {
    expect(fleschKincaidGrade("I write short lines. You read them fast.")).toBeLessThan(6);
    expect(
      fleschKincaidGrade(
        "Notwithstanding the aforementioned organizational infrastructure, unprecedented optimization facilitates multifaceted operational dimensions.",
      ),
    ).toBeGreaterThan(8);
  });
});
