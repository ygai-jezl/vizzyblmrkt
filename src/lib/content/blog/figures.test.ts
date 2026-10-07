import { describe, expect, it } from "vitest";
import { articleFigures, factFiguresOnPage, figureSet, normalizeFigure, unsupportedFigures } from "./figures";

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
});
