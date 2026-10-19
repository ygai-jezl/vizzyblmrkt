import { describe, expect, it } from "vitest";
import { renderPng, RENDER_SIZES } from "./render";
import { bundledFontPlan } from "./renderFonts";
import { dataStory, niceMax } from "./templates/dataStory";
import { typePoster } from "./templates/typePoster";
import { highlightedText, pointText, type TemplateInput } from "./templates/shared";
import { templateFor } from "./styleImage";
import type { Chart } from "@/lib/types/imageStyle";

const line: Chart = { kind: "line", unit: "%", points: [{ label: "1 Sep", value: 0 }, { label: "28 Sep", value: 100, display: "100%" }, { label: "4 Oct", value: 0 }], highlight: 1, source: "Our data" };
const bar: Chart = { kind: "bar", unit: "%", points: [{ label: "ChatGPT", value: 42 }, { label: "Gemini", value: 31 }, { label: "Claude", value: 9 }] };
const compare: Chart = { kind: "compare", unit: "links", points: [{ label: "Before", value: 0 }, { label: "After", value: 4235, display: "4,235" }] };

async function sizesOk(make: (i: Omit<TemplateInput, "fonts">) => TemplateInput, name: string) {
  const plan = await bundledFontPlan();
  for (const [size, { width, height }] of Object.entries(RENDER_SIZES)) {
    const input = make({ width, height, headline: "For 19 days, it *stopped.*", eyebrow: "Research", footer: "example.com", accent: "#5B4FE6", brandName: "Example" });
    const png = await renderPng((name === "poster" ? typePoster : dataStory)({ ...input, fonts: { heading: plan.heading, body: plan.body } }), { width, height, fonts: plan.fonts });
    expect(png, `${name} ${size}`).not.toBeNull();
    expect([png!.readUInt32BE(16), png!.readUInt32BE(20)], `${name} ${size}`).toEqual([width, height]);
  }
}

describe("v2 drawn styles", () => {
  it("Data story draws a line, bars, a before and after, and a headline alone, at every size", async () => {
    for (const [name, chart] of [["line", line], ["bar", bar], ["compare", compare], ["none", null]] as const) {
      await sizesOk((i) => ({ ...i, chart, fonts: { heading: "", body: "" } }), `data ${name}`);
    }
  }, 60_000);

  it("Type poster draws with a number and without one, at every size", async () => {
    await sizesOk((i) => ({ ...i, figure: { value: "4,235", unit: "links" }, fonts: { heading: "", body: "" } }), "poster");
    await sizesOk((i) => ({ ...i, accent: "#F2C14E", fonts: { heading: "", body: "" } }), "poster");
  }, 60_000);

  it("helpers: a round axis top, numbers as the copy writes them, the highlighted words", () => {
    expect([niceMax(100), niceMax(87), niceMax(4235), niceMax(0)]).toEqual([100, 100, 5000, 1]);
    expect(pointText({ label: "a", value: 4235 }, "links")).toBe("4,235 links");
    expect(pointText({ label: "a", value: 42 }, "%")).toBe("42%");
    expect(pointText({ label: "a", value: 42, display: "42 percent" }, "%")).toBe("42 percent");
    expect(highlightedText("Then it *stopped.*")).toBe("stopped.");
    expect(highlightedText("No stars")).toBeNull();
    expect([templateFor("data_story"), templateFor("type_poster"), templateFor("soft_3d")]).toEqual(["data_story", "type_poster", null]);
  });
});
