import { describe, expect, it } from "vitest";
import {
  articleFigures,
  factFiguresOnPage,
  factWordedAs,
  figureSet,
  normalizeFigure,
  unsupportedFigures,
  wordingShared,
  wordsOf,
} from "./figures";

describe("figures", () => {
  it("normalizes separators and trailing zeros", () => {
    expect(normalizeFigure("2,300")).toBe("2300");
    expect(normalizeFigure("2.0")).toBe("2");
    expect(normalizeFigure("14.20")).toBe("14.2");
    expect(normalizeFigure("007")).toBe("7");
    expect([...figureSet("from 550 to 2,300 in 4 weeks")]).toEqual(["550", "2300", "4"]);
  });

  it("reads the figures an article states, with their units", () => {
    const md = [
      "# What is it?",
      "*Last updated: 2026-10-07*",
      "Trials grew 4x, from 550 to 2,300, and 45% of buyers saw it. The market is worth $1.2 billion.",
      "1. First do this",
      "2. Then do that",
    ].join("\n");
    expect(articleFigures(md).map((f) => f.display)).toEqual(["4x", "550", "2,300", "45%", "$1.2 billion"]);
  });

  it("leaves alone what counts, names or links rather than claims", () => {
    const md =
      "Follow these 3 steps with B2B teams, 24/7, on the 2nd try. We compared tools like Gemini 2.5 and Claude. " +
      "See [the 2024 report](https://example.com/report-2024-99) and H2 headings.";
    expect(articleFigures(md).map((f) => f.display)).toEqual(["2024"]);
  });

  it("does not read figures out of code or schema markup", () => {
    const md = 'Use this markup:\n\n```json\n{ "wordCount": 1200, "ratingValue": 4.8 }\n```\n\nSet `maxAge=3600` and move on.';
    expect(articleFigures(md)).toEqual([]);
  });

  it("lets the article use the current year without a source", () => {
    expect(articleFigures("The 2026 buyer expects more.", { ignoreYears: [2026] })).toEqual([]);
    expect(articleFigures("The 2026 buyer expects more.").map((f) => f.display)).toEqual(["2026"]);
  });

  it("flags only the figures the writer was never given", () => {
    const reference = "Customer X grew from 550 to 2300 trials (a 4x lift) in 4 weeks.";
    const md = "Trials went from 550 to 2,300 — a 4x lift — and churn fell 38%.";
    expect(unsupportedFigures(md, reference)).toEqual(["38%"]);
  });

  it("confirms a fact only when every figure it states is on the page", () => {
    const page = "Our analysis of 12.3 million visits found AI search converts at 14.2% vs 2.8% for organic.";
    expect(factFiguresOnPage("AI search traffic converts at 14.2% compared to 2.8% for organic.", page)).toBe(true);
    expect(factFiguresOnPage("AI search traffic converts at 41% compared to 2.8% for organic.", page)).toBe(false);
    // Nothing to check is not a verified claim.
    expect(factFiguresOnPage("AI search traffic converts better than organic search.", page)).toBe(false);
  });

  it("does not take a digit inside a word or a name for a figure the fact states", () => {
    // A page with a 2, a 7 and a 4 on it — as any page has.
    const page = "Founded 2 years ago, open 24/7, with 4 offices and 12.3 million visits.";
    for (const fact of [
      "Nearly three-quarters of B2B software buyers now use an AI assistant, according to research cited by ExampleScale.",
      "Tier2 Research says most buyers start with an AI chatbot.",
      "Support is available 24/7 for every customer.",
      "It is the 2nd most used tool, after H1 headings.",
    ]) {
      expect(factFiguresOnPage(fact, page), fact).toBe(false);
    }
    // The figure a B2B fact does state is still what is looked for.
    expect(factFiguresOnPage("B2B sites had 12.3 million visits.", page)).toBe(true);
    expect(factFiguresOnPage("B2B sites had 99 million visits.", page)).toBe(false);
  });

  it("tells a fact worded as the page words it from the same figures in another claim", () => {
    const page = wordsOf("Of 2,400 buyers surveyed, 63% asked an AI assistant for a shortlist before visiting a vendor site.");
    expect(factWordedAs("63% of 2,400 buyers surveyed asked an AI assistant for a shortlist before visiting a vendor site.", page)).toBe(true);
    // Other endings of the same words are the same words.
    expect(factWordedAs("A survey of 2,400 buyers: 63% ask AI assistants for shortlists before they visit vendor sites.", page)).toBe(true);
    expect(factWordedAs("63% of the 2,400 buyers surveyed trust an AI assistant more than a salesperson.", page)).toBe(false);
    expect(wordingShared("Trust rose sharply among younger managers everywhere.", page)).toBe(0);
    // Too short to judge by its words, or written without spaces: the figures decide alone.
    expect(factWordedAs("63% said yes.", page)).toBe(true);
    expect(factWordedAs("調査対象の購入者2,400人のうち63%がAIアシスタントに候補リストを求めた。", page)).toBe(true);
  });
});
