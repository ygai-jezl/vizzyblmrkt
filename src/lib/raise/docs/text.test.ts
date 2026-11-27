import { describe, expect, it } from "vitest";
import { block, NOW } from "./testing/fixtures";
import {
  clock,
  countWords,
  dayWords,
  formatValue,
  keepTokens,
  labelWords,
  periodWordsFor,
  promptLabels,
  citationsOut,
  citeLabels,
  renderText,
  segmentsOf,
  slideWordsOf,
  talkSeconds,
  talkTime,
  textOf,
  tokenIdsIn,
  wordsOf,
} from "./text";

const B = block({ id: "mb_aaaaaaaa", display: "4,310", periodWords: "12 weeks to 26 Nov" });

describe("number tokens", () => {
  it("split text into runs and tokens, and back again unchanged", () => {
    const text = "{{mb_aaaaaaaa}} people joined in {{mb_aaaaaaaa:period}}.";
    const segs = segmentsOf(text);
    expect(segs).toEqual([
      { kind: "block", id: "mb_aaaaaaaa", part: "display" },
      { kind: "text", text: " people joined in " },
      { kind: "block", id: "mb_aaaaaaaa", part: "period" },
      { kind: "text", text: "." },
    ]);
    expect(textOf(segs)).toBe(text);
    expect(segmentsOf("No numbers here")).toEqual([{ kind: "text", text: "No numbers here" }]);
    expect(tokenIdsIn(text)).toEqual(["mb_aaaaaaaa"]);
  });

  it("render with the block's display and period words", () => {
    expect(renderText("{{mb_aaaaaaaa}} joined the waitlist in {{mb_aaaaaaaa:period}}", [B])).toBe("4,310 joined the waitlist in 12 weeks to 26 Nov");
  });

  it("render a token for a removed block as nothing, and drop it on save", () => {
    expect(renderText("Up {{mb_zzzzzzzz}} this year", [B])).toBe("Up this year");
    expect(keepTokens("{{mb_aaaaaaaa}} and {{mb_zzzzzzzz}}", new Set(["mb_aaaaaaaa"]))).toBe("{{mb_aaaaaaaa}} and ");
    // Not a token: the wrong shape is plain text.
    expect(renderText("{{b1}} stays", [B])).toBe("{{b1}} stays");
  });
});

describe("words and talk time", () => {
  it("count words in the notes, and on the slide without its notes", () => {
    expect(countWords("One idea a slide.  The headline says the point.")).toBe(9);
    const s = { headline: "{{mb_aaaaaaaa}} joined", points: ["A real problem"], blocks: [B], notes: "Say it in four words." };
    expect(wordsOf(s)).toBe(5);
    expect(slideWordsOf({ ...s, compare: undefined, people: [{ name: "Sam Lee", role: "Founder", line: "Ran shops" }] })).toBe(2 + 3 + 2 + 1 + 2);
  });

  it("works talk time out at 150 words a minute, rounded", () => {
    expect(talkSeconds(150)).toBe(60);
    expect(talkSeconds(75)).toBe(30);
    expect(talkSeconds(1)).toBe(0);
    expect(talkSeconds(3)).toBe(1);
    expect(talkTime(40)).toBe("40 seconds");
    expect(talkTime(60)).toBe("1 minute");
    expect(talkTime(200)).toBe("3 minutes");
    expect(clock(75)).toBe("1:15");
  });
});

describe("formatting", () => {
  it("formats counts, money, percents and 'a month'", () => {
    expect(formatValue({ value: 4310, unit: "count" })).toBe("4,310");
    expect(formatValue({ value: 14200, unit: "money", currency: "GBP", per: "month" })).toBe("£14,200 a month");
    expect(formatValue({ value: 6200, unit: "money", currency: "USD", per: null })).toBe("$6,200");
    expect(formatValue({ value: 2.5, unit: "money", currency: "EUR", per: "year" })).toBe("€2.5 a year");
    expect(formatValue({ value: 18.4, unit: "percent" })).toBe("+18%");
    expect(formatValue({ value: -5, unit: "percent" })).toBe("-5%");
    expect(formatValue({ value: null, unit: "count" })).toBe("");
  });

  it("labels a number with where it came from and its date, with the year only outside this one", () => {
    expect(labelWords(block({ asOf: NOW.toISOString() }), NOW)).toBe("Seen by YouGrow, 26 Nov");
    expect(labelWords(block({ source: { kind: "typed" }, asOf: NOW.toISOString() }), NOW)).toBe("Typed by you, 26 Nov");
    expect(labelWords(block({ source: { kind: "typed", from: "your till" }, asOf: "2025-03-02T00:00:00.000Z" }), NOW)).toBe("Typed by you, from your till, 2 Mar 2025");
    expect(dayWords("2026-01-09T00:00:00.000Z", NOW)).toBe("9 Jan");
    expect(periodWordsFor(12, NOW.toISOString(), NOW)).toBe("12 weeks to 26 Nov");
  });
});

describe("the prompt's own ids in a slide's words", () => {
  const labels = promptLabels({ lines: [{ id: "P1" }, { id: "P2" }, { id: "P3" }], authors: [{ ref: "A1" }], numbers: { launches: [{}, {}] } });
  const cite = citeLabels(labels, []);

  it("lists the pack, team and launch ids, and no task ids", () => {
    expect([...labels].sort()).toEqual(["A1", "L1", "L2", "P1", "P2", "P3"]);
  });

  it("never counts an id that is a word in what the model was shown", () => {
    expect([...citeLabels(labels, ["A1 Taxis gets you home", "Fees stay low on an L2"])].sort()).toEqual(["L1", "P1", "P2", "P3"]);
  });

  it("takes out a bracket of ids only, and names any other id left in the words", () => {
    expect(citationsOut("Shops come back weekly (P3).", cite)).toEqual({ text: "Shops come back weekly.", stray: [] });
    expect(citationsOut("Growth [P1, P3] since spring", cite)).toEqual({ text: "Growth since spring", stray: [] });
    for (const s of ["(P1/P2)", "(P1-P3)", "(P1 to P3)", "(P1 and P2)"]) expect(citationsOut(`Weekly ${s}`, cite).text, s).toBe("Weekly");
    expect(citationsOut("As P1 says, stock day eats a Sunday.", cite)).toEqual({ text: "As P1 says, stock day eats a Sunday.", stray: ["P1"] });
    expect(citationsOut("Our loan book is rated A1 by our bank", cite)).toEqual({ text: "Our loan book is rated A1 by our bank", stray: ["A1"] });
  });

  it("leaves number tokens, other words and text with no ids as they were", () => {
    expect(citationsOut("{{mb_abcd1234}} shops joined in {{mb_abcd1234:period}} (P2)", cite).text).toBe("{{mb_abcd1234}} shops joined in {{mb_abcd1234:period}}");
    expect(citationsOut("For people with T1 diabetes (see our study)", cite)).toEqual({ text: "For people with T1 diabetes (see our study)", stray: [] });
    expect(citationsOut("Our P9 plan", cite)).toEqual({ text: "Our P9 plan", stray: [] });
    const shown = citeLabels(labels, ["Learners go from A1 to B2"]);
    expect(citationsOut("Learners go from A1 to B2 in six months", shown)).toEqual({ text: "Learners go from A1 to B2 in six months", stray: [] });
  });
});
