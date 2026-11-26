import { describe, expect, it } from "vitest";
import { deckChecks, numbersIn, type CheckCode } from "./checks";
import { block, preSeedSlides, slide } from "./testing/fixtures";
import type { Slide } from "./types";
import { CHECK_WORDS } from "./words";

const codes = (slides: Slide[], audience: "investor" | "lender" = "investor") => deckChecks({ audience, slides }).map((c) => c.code);
const only = (code: CheckCode, slides: Slide[], audience: "investor" | "lender" = "investor") => deckChecks({ audience, slides }).filter((c) => c.code === code);

/** A full pre-seed deck with one slide swapped. */
function deckWith(i: number, s: Partial<Slide>): Slide[] {
  const d = preSeedSlides();
  d[i] = { ...d[i]!, ...s };
  return d;
}

describe("deck checks", () => {
  it("are quiet on a clean pre-seed deck", () => {
    expect(codes(preSeedSlides())).toEqual([]);
  });

  it("find a number typed into a headline, point or compare cell, but not a year or a token", () => {
    expect(numbersIn("We grew 40% to £14,200 in 2025, up from Q3 and B2B")).toEqual(["40%", "£14,200"]);
    const d = deckWith(1, { headline: "Shop owners lose 6 hours a week", points: ["Since 2024 it got worse"] });
    expect(only("number_no_source", d)).toEqual([{ code: "number_no_source", slideId: d[1]!.id, message: CHECK_WORDS.number_no_source("6") }]);
    const withToken = deckWith(3, { headline: "{{mb_aaaaaaaa}} people joined in twelve weeks", blocks: [block()] });
    expect(only("number_no_source", withToken)).toEqual([]);
    const compare = deckWith(6, { layout: "compare", compare: { leftTitle: "Today", rightTitle: "With us", rows: [{ left: "3 apps", right: "One place" }] } });
    expect(only("number_no_source", compare).map((c) => c.message)).toEqual([CHECK_WORDS.number_no_source("3")]);
  });

  it("find a number in the notes that no block shows", () => {
    const d = deckWith(3, { blocks: [block({ value: 4310, display: "4,310" })], notes: "We reached 4,310 sign-ups, and 300 came last week." });
    expect(only("number_in_notes", d).map((c) => c.message)).toEqual([CHECK_WORDS.number_in_notes("300")]);
    // A figure any slide shows is fine, wherever its block is.
    const elsewhere = deckWith(9, { notes: "Remember the 4,310." });
    elsewhere[3] = { ...elsewhere[3]!, blocks: [block()] };
    expect(only("number_in_notes", elsewhere)).toEqual([]);
  });

  it("find a headline that only names the section, or says too little", () => {
    expect(codes(deckWith(2, { headline: "Solution" }))).toEqual(["headline_label"]);
    expect(codes(deckWith(2, { headline: "Our solution" }))).toEqual(["headline_label"]);
    expect(codes(deckWith(4, { headline: "Why now?" }))).toEqual(["headline_label"]);
    expect(codes(deckWith(2, { headline: "Counts stock while you sleep" }))).toEqual([]);
    // The cover is the business's name.
    expect(codes(deckWith(0, { headline: "Acme" }))).toEqual([]);
  });

  it("count words on the slide, not in its notes", () => {
    const long = Array.from({ length: 31 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(" ");
    expect(only("too_many_words", deckWith(1, { headline: long })).map((c) => c.message)).toEqual([CHECK_WORDS.too_many_words(31)]);
    expect(only("too_many_words", deckWith(1, { notes: long }))).toEqual([]);
  });

  it("miss why now, the ask and the core sections on an investor deck", () => {
    const d = preSeedSlides().filter((s) => !["why_now", "ask", "team"].includes(s.section));
    expect(deckChecks({ audience: "investor", slides: d }).map((c) => [c.code, c.slideId, c.message])).toEqual([
      ["missing_why_now", null, CHECK_WORDS.missing_why_now],
      ["missing_ask", null, CHECK_WORDS.missing_ask],
      ["missing_section", null, CHECK_WORDS.missing_section("team")],
    ]);
  });

  it("miss repayment on a lender pack, and never ask a lender for why now or check its terms", () => {
    const lender = [
      slide({ section: "cover", headline: "Fernhill Plants" }),
      slide({ section: "sales", headline: "Sales have held steady all year round" }),
      slide({ section: "use_of_funds", layout: "ask", headline: "New stock for the spring season ahead", points: ["A discount from our grower"] }),
      slide({ section: "team", headline: "Two of us run the shop every day" }),
    ];
    expect(codes(lender, "lender")).toEqual(["missing_repayment"]);
    expect(only("terms_on_ask", lender, "lender")).toEqual([]);
  });

  it("find valuation or terms on an investor ask slide", () => {
    expect(codes(deckWith(9, { headline: "Raising at a fair valuation for eighteen months" }))).toEqual(["terms_on_ask"]);
    expect(codes(deckWith(9, { points: ["Pre-money terms to follow"] }))).toEqual(["terms_on_ask"]);
    expect(codes(deckWith(9, { headline: "Raising to reach our next milestone fast" }))).toEqual([]);
  });

  it("find a typed series that only goes up, and a typed chart with no source", () => {
    const series = (values: number[]) => values.map((value, i) => ({ label: `M${i + 1}`, value }));
    const rising = block({ id: "mb_bbbbbbbb", meaning: "typed", grain: "month", series: series([10, 20, 30, 40]), source: { kind: "typed", from: "your till" } });
    expect(codes(deckWith(3, { blocks: [rising] }))).toEqual(["cumulative_chart"]);
    const real = { ...rising, series: series([10, 25, 20, 40]) };
    expect(codes(deckWith(3, { blocks: [real] }))).toEqual([]);
    const unsourced = { ...real, source: { kind: "typed" as const } };
    expect(codes(deckWith(3, { blocks: [unsourced] }))).toEqual(["chart_no_source"]);
  });

  it("never finds a running total in YouGrow's own weekly counts", () => {
    const weekly = block({ grain: "week", series: [1, 2, 3, 4, 5, 6].map((value, i) => ({ label: `W${i}`, value })) });
    expect(codes(deckWith(3, { blocks: [weekly] }))).toEqual([]);
  });

  it("find more than 3 slides on one section", () => {
    const d = [...preSeedSlides(), ...[1, 2, 3].map((i) => slide({ section: "problem", headline: `Another real problem number ${["one", "two", "three"][i - 1]}` }))];
    expect(only("too_many_in_section", d).map((c) => c.message)).toEqual([CHECK_WORDS.too_many_in_section(4, "problem")]);
  });

  it("find dashes and stock phrases in slide text and notes", () => {
    expect(only("house_style", deckWith(1, { headline: "Stock counts — a weekly chore for shops" }))).toHaveLength(1);
    expect(only("house_style", deckWith(1, { notes: "We help shops unlock their time." })).map((c) => c.message)).toEqual([CHECK_WORDS.house_style("unlock")]);
    expect(only("house_style", deckWith(1, { headline: "A follow-up for every pre-seed shop" }))).toEqual([]);
  });
});
