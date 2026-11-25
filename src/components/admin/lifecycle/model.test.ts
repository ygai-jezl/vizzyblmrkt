import { describe, expect, it } from "vitest";
import { ISSUE_TEXT, issueText } from "./model";

describe("a journey's issues in words", () => {
  it("name a launch's welcome journey, or an idea's while the words are on", () => {
    expect(issueText({ code: "ab_test_waitlist_only" })).toBe("A/B tests are for a launch's welcome journey.");
    expect(issueText({ code: "ab_test_waitlist_only" }, true)).toBe("A/B tests are for an idea's welcome journey.");
    expect(issueText({ code: "field_not_for_product" }, true)).toBe("Signup details are only for an idea's welcome journey.");
    expect(issueText({ code: "exit_target_waitlist_only" }, true)).toBe("Only an idea's welcome journey can hand people to the weekly newsletter.");
  });

  it("say launch nowhere else, so the other issues read the same in both words", () => {
    const naming = Object.entries(ISSUE_TEXT).filter(([, text]) => /\blaunch/i.test(text)).map(([code]) => code);
    expect(naming.sort()).toEqual(["ab_test_waitlist_only", "exit_target_waitlist_only", "field_not_for_product"]);
    for (const code of Object.keys(ISSUE_TEXT)) {
      expect(issueText({ code }, true), code).not.toMatch(/\blaunch/i);
    }
    expect(issueText({ code: "no_email", detail: "pool_1" }, true)).toBe("Add at least one email. (pool_1)");
  });
});
