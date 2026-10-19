import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, chartFromDraft, draftFromChart, numberOf } from "./chartDraft";
import { ChartEditor } from "./ChartEditor";

describe("the Numbers editor's draft", () => {
  it("reads numbers as people write them", () => {
    expect([numberOf("4,235"), numberOf("42%"), numberOf("$1.2m"), numberOf("-3"), numberOf("none")]).toEqual([4235, 42, 1.2, -3, null]);
  });

  it("makes a chart once two rows are complete, keeping how the number was written", () => {
    expect(chartFromDraft(EMPTY_DRAFT)).toBeNull();
    const chart = chartFromDraft({ kind: "bar", unit: "", source: " Our data ", rows: [{ label: "ChatGPT", value: "42%" }, { label: "Gemini", value: "31" }, { label: "", value: "9" }] });
    expect(chart).toEqual({ kind: "bar", unit: "", source: "Our data", points: [{ label: "ChatGPT", value: 42, display: "42%" }, { label: "Gemini", value: 31 }] });
    expect(chartFromDraft({ ...EMPTY_DRAFT, kind: "compare", rows: [{ label: "a", value: "1" }, { label: "b", value: "2" }, { label: "c", value: "3" }] })?.kind).toBe("bar");
  });

  it("round-trips a saved chart", () => {
    const chart = { kind: "line" as const, unit: "%", points: [{ label: "1 Sep", value: 0 }, { label: "28 Sep", value: 100, display: "100%" }] };
    expect(chartFromDraft(draftFromChart(chart))).toEqual(chart);
  });

  it("the editor shows a row per number and offers more", () => {
    const html = renderToStaticMarkup(createElement(ChartEditor, { draft: EMPTY_DRAFT, onChange: () => {}, note: "Found in your post. Edit any." }));
    expect(html).toContain("Numbers on the image");
    expect(html).toContain("Found in your post. Edit any.");
    expect(html.match(/aria-label="Label /g)).toHaveLength(2);
    expect(html).toContain("+ Add a number");
    expect(html).toContain("Before and after");
  });
});
