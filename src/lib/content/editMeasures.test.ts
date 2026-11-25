import { describe, expect, it } from "vitest";
import { changedWords, editMeasures, sectionChanges, splitSections } from "./editMeasures";

/** How a person changed the AI draft: section by section for an article, whole for a post. */

const ARTICLE = [
  "# How to track AI visibility",
  "",
  "Tracking shows where your brand appears in AI answers.",
  "",
  "## Why it matters",
  "",
  "Buyers ask ChatGPT before they ask you. 45% of them start there.",
  "",
  "## How it works",
  "",
  "A tool asks the engines your buyers' questions every day and keeps what they cite. See [the guide](https://a.example.com/guide).",
  "",
  "## What it costs",
  "",
  "Most tools cost between $50 and $500 a month.",
].join("\n");

const T0 = "2026-11-20T10:00:00.000Z";
const T1 = "2026-11-20T12:30:00.000Z";

describe("splitSections", () => {
  it("splits on H2 only, keeping the opening and ignoring headings in code", () => {
    const s = splitSections("# Title\n\nIntro\n\n## One\n\nA\n\n### Sub\n\nB\n\n```\n## not a heading\n```\n\n## Two\n\nC\n");
    expect(s.map((x) => x.heading)).toEqual(["", "One", "Two"]);
    expect(s[1]!.text).toContain("### Sub");
    expect(s[1]!.text).toContain("## not a heading");
  });
});

describe("editMeasures", () => {
  it("says a draft approved as written changed nothing", () => {
    const m = editMeasures(ARTICLE, ARTICLE, { originalAt: T0, approvedAt: T1, regenerations: 0 });
    expect(m).toMatchObject({ wordsChanged: 0, wordsChangedShare: 0, approvedAsWritten: true, sectionsAdded: [], sectionsCut: [], minutesToApprove: 150 });
  });

  it("counts sections added, cut and changed, figures and links", () => {
    const edited = ARTICLE.replace("45% of them", "60% of them")
      .replace("## What it costs\n\nMost tools cost between $50 and $500 a month.", "## Who it's for\n\nAgencies with many clients.")
      .replace("See [the guide](https://a.example.com/guide).", "See [our notes](https://b.example.com/notes).");
    const m = editMeasures(ARTICLE, edited, { originalAt: T0, approvedAt: T1, regenerations: 2 });
    expect(m.sectionsAdded).toEqual(["Who it's for"]);
    expect(m.sectionsCut).toEqual(["What it costs"]);
    expect(m.sectionsChanged).toBe(2);
    expect(m.figuresAdded).toContain("60%");
    expect(m.figuresRemoved).toEqual(expect.arrayContaining(["45%", "$500"]));
    expect(m.linksAdded).toEqual(["https://b.example.com/notes"]);
    expect(m.linksCut).toEqual(["https://a.example.com/guide"]);
    expect(m.regenerations).toBe(2);
    expect(m.approvedAsWritten).toBe(false);
    expect(m.wordsChangedShare).toBeGreaterThan(0);
    expect(m.wordsChangedShare).toBeLessThanOrEqual(1);
  });

  it("doesn't count a moved section as rewritten", () => {
    const [intro, why, how, cost] = splitSections(ARTICLE);
    const moved = [intro, how, why, cost].map((s) => (s!.heading ? `## ${s!.heading}\n${s!.text}` : s!.text)).join("");
    const m = editMeasures(ARTICLE, moved, { approvedAt: T1, regenerations: 0 });
    expect(m.wordsChanged).toBe(0);
    expect(m.minutesToApprove).toBeNull();
  });

  it("compares a post whole", () => {
    const m = editMeasures("Big news today. We launched.", "Big news. We launched our app.", { approvedAt: T1, regenerations: 0, sections: false });
    expect(m.wordsChanged).toBeGreaterThan(0);
    expect(m.sectionsChanged).toBe(0);
  });

  it("works on a long article the word diff alone can't take", () => {
    const para = (i: number) => Array.from({ length: 60 }, (_, j) => `w${i}x${j}`).join(" ");
    const long = Array.from({ length: 50 }, (_, i) => para(i)).join("\n\n");
    const edited = long.replace(para(7), `${para(7)} plus four new words`);
    expect(long.split(/\s+/).length).toBe(3000);
    expect(changedWords(long, edited)).toBe(4);
    const m = editMeasures(long, edited, { approvedAt: T1, regenerations: 0 });
    expect(m.wordsChanged).toBe(4);
    expect(m.wordsChangedShare).toBe(0.001);
  });
});

describe("sectionChanges", () => {
  it("lists each section in the approved order, with a cut one where it was", () => {
    const edited = ARTICLE.replace("## How it works\n\nA tool asks the engines your buyers' questions every day and keeps what they cite. See [the guide](https://a.example.com/guide).\n\n", "");
    const s = sectionChanges(ARTICLE, edited);
    expect(s.map((x) => [x.heading, x.state])).toEqual([
      ["", "same"],
      ["Why it matters", "same"],
      ["How it works", "cut"],
      ["What it costs", "same"],
    ]);
  });
});
