import { describe, expect, it, vi } from "vitest";
import { chartFromCopy, figureFromCopy, labelInText, verifyChart } from "./chartFromCopy";
import type { Chart } from "@/lib/types/imageStyle";

const COPY = `Gemini tagged its citation links for 19 days. Before 10 Sep, 0% carried a UTM tag.
On 28 September, 100% of 4,235 links did. Since 29 Sep, none have. Source: Vizzybl monitoring.`;

const chart = (points: Chart["points"], over: Partial<Chart> = {}): Chart => ({ kind: "line", unit: "%", points, ...over });

describe("verifyChart", () => {
  it("keeps only numbers and labels the copy holds", () => {
    const out = verifyChart(
      chart(
        [
          { label: "Before 10 Sep", value: 0, display: "0%" },
          { label: "28 Sep", value: 100, display: "100%" },
          { label: "Oct", value: 87 }, // invented value
          { label: "Next week", value: 100 }, // label not in the copy
        ],
        { highlight: 1, source: "Vizzybl monitoring" },
      ),
      { text: COPY },
    );
    expect(out).toEqual({
      kind: "line",
      unit: "%",
      points: [
        { label: "Before 10 Sep", value: 0, display: "0%" },
        { label: "28 Sep", value: 100, display: "100%" },
      ],
      highlight: 1,
      source: "Vizzybl monitoring",
    });
  });

  it("drops a figure the fact check flagged, a display the copy doesn't write, and a made-up source", () => {
    const out = verifyChart(
      chart([{ label: "28 Sep", value: 100, display: "100 percent" }, { label: "links", value: 4235 }, { label: "days", value: 19 }], { source: "Gartner" }),
      { text: COPY, excluded: ["4,235"] },
    );
    expect(out?.points).toEqual([{ label: "28 Sep", value: 100 }, { label: "days", value: 19 }]);
    expect(out).not.toHaveProperty("source");
    expect(verifyChart(chart([{ label: "28 Sep", value: 100 }, { label: "links", value: 4235 }]), { text: COPY, excluded: ["4,235"] })).toBeNull();
  });

  it("Before and After are fine for one sentence's change, never to pair two unrelated numbers", () => {
    const text = "Harbor's share of voice rose from 6% to 21%. Separately, AI traffic converts at 14.2%.";
    const ok = verifyChart(chart([{ label: "Before", value: 6, display: "6%" }, { label: "After", value: 21, display: "21%" }], { kind: "compare" }), { text });
    expect(ok?.points.map((p) => p.label)).toEqual(["Before", "After"]);
    expect(verifyChart(chart([{ label: "Before", value: 6 }, { label: "After", value: 14.2 }], { kind: "compare" }), { text })).toBeNull();
    expect(verifyChart(chart([{ label: "Before", value: 6 }, { label: "After", value: 21 }], { kind: "bar" }), { text })).toBeNull();
  });

  it("a compare needs exactly two points; labels match whatever the month's length", () => {
    expect(verifyChart(chart([{ label: "19 days", value: 19 }, { label: "28 Sep", value: 100 }, { label: "4,235 links", value: 4235 }], { kind: "compare" }), { text: COPY })?.kind).toBe("bar");
    expect(labelInText("28 Sep", "On 28 September it changed")).toBe(true);
    expect(labelInText("Sep 28", "On 28 September it changed")).toBe(true);
    expect(labelInText("Oct 28", "On 28 September it changed")).toBe(false);
  });
});

describe("chartFromCopy", () => {
  it("asks the model, then checks what it said", async () => {
    const generate = vi.fn(async (_prompt: string) =>
      JSON.stringify({ kind: "line", unit: "%", points: [{ label: "Before 10 Sep", value: 0 }, { label: "28 Sep", value: 100 }, { label: "Nov", value: 55 }] }),
    );
    const out = await chartFromCopy({ text: COPY }, { generate });
    expect(out?.points.map((p) => p.label)).toEqual(["Before 10 Sep", "28 Sep"]);
    expect(generate.mock.calls[0]![0]).toContain("<copy>");
  });

  it("null when the copy has too few numbers, the model says none, or it fails", async () => {
    const generate = vi.fn(async (_prompt: string) => JSON.stringify({ none: true }));
    expect(await chartFromCopy({ text: "We grew a lot this year." }, { generate })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(await chartFromCopy({ text: COPY }, { generate })).toBeNull();
    expect(await chartFromCopy({ text: COPY }, { generate: async () => null })).toBeNull();
    expect(await chartFromCopy({ text: COPY }, { generate: async () => "not json" })).toBeNull();
  });
});

describe("figureFromCopy", () => {
  it("the first figure the copy states, with the word after it", () => {
    expect(figureFromCopy({ text: COPY })).toEqual({ value: "19", unit: "days" });
    expect(figureFromCopy({ text: "In 2026, 42% of buyers asked an AI first." })).toEqual({ value: "42%", unit: "" });
    expect(figureFromCopy({ text: COPY, excluded: ["19"] })).toEqual({ value: "0%", unit: "" });
    expect(figureFromCopy({ text: "No numbers here, only 3 steps." })).toBeNull();
    expect(figureFromCopy({ text: "42 marketing teams said so." })).toEqual({ value: "42", unit: "marketing" });
  });
});
