import { describe, expect, it } from "vitest";
import type { CallSites } from "./callSites";
import { kindLabel, learningCounts, renderLearningSection } from "./learningDoc";
import { gap, LOOPS, none, own, type Decision, type LoopKind } from "./registry";

/** Every kind with no call site, plus a few made in made-up files. */
const empty = Object.fromEntries(Object.keys(LOOPS).map((k) => [k, []])) as unknown as CallSites;
const sites: CallSites = {
  ...empty,
  content_write: ["src/a.ts", "src/b.ts"],
  content_email: ["src/b.ts"],
  trending: ["src/c.ts"],
};
/** A small set of lines, standing in for the registry. */
const lines = {
  content_write: own("post_learning", "Hearth Bakery's posts follow how its past posts did on LinkedIn."),
  content_email: gap("Hearth Bakery's workflow emails keep no first draft beside the team's edits.", "2027-03-31"),
  email_hero: gap("Hearth Bakery's email heroes skip the look its team voted for.", "2027-01-31"),
  trending: none("Trending topics are a fact about the week, not a taste of Hearth Bakery's."),
} as unknown as Readonly<Record<LoopKind, Decision>>;

describe("the Learning section", () => {
  it("counts kinds and call sites by decision, and the call sites that do not learn", () => {
    const c = learningCounts(sites, lines);
    expect(c.kinds).toEqual({ learns: 0, fleet: 0, own: 1, gap: 2, none: 1 });
    expect(c.sites).toEqual({ learns: 0, fleet: 0, own: 2, gap: 1, none: 1 });
    expect(c.totalKinds).toBe(4);
    expect(c.totalSites).toBe(4);
    expect(c.notLearning).toBe(2);
  });

  it("shows each kind under its decision with its reason, date and files, gaps by date", () => {
    const text = renderLearningSection(sites, lines).join("\n");
    expect(text).toContain("4 kinds: 0 learn, 0 fleet only, 1 own, 2 gap and 1 none.");
    expect(text).toContain("Not learning: 2 of 4 call sites, under gap and none lines.");
    expect(text).toContain("- `content_write` (AI purpose, Writing posts), kept in `post_learning`. Hearth Bakery's posts follow how its past posts did on LinkedIn.\n  - `src/a.ts`\n  - `src/b.ts`");
    expect(text).toContain("- `trending` (AI purpose, Trending topics). Trending topics are a fact");
    expect(text.indexOf("`email_hero`")).toBeLessThan(text.indexOf("`content_email`"));
    expect(text).toContain("look again by 2027-01-31. Hearth Bakery's email heroes skip the look its team voted for.\n  - No call site in the code.");
    expect(text).toContain("### Learns\n\nNo line says this yet.");
    expect(text).toContain("### Fleet only\n\nNo line says this yet.");
  });

  it("names each group of kinds plainly", () => {
    expect(kindLabel("canvas.journey")).toBe("canvas");
    expect(kindLabel("rising_search")).toBe("connector rule");
    expect(kindLabel("send_time")).toBe("rule, Send time");
    expect(kindLabel("content_email")).toMatch(/^AI purpose, \S/);
  });
});
