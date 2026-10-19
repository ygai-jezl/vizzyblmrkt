import { describe, expect, it } from "vitest";
import { renderPng, RENDER_SIZES, toFontWeight } from "./render";
import { bundledFontPlan } from "./renderFonts";
import { productNoir } from "./templates/productNoir";
import { headlineCard } from "./templates/headlineCard";
import { titleCard } from "./templates/titleCard";
import { artOverlay } from "./templates/artOverlay";
import { headlineWords, inkOn, sizeFor, type TemplateInput } from "./templates/shared";

// A real 1x1 PNG, standing in for a screenshot, logo or painted art.
const PIXEL = {
  src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  width: 1,
  height: 1,
};

describe("templates", () => {
  it("every template draws a PNG of the right size, at every size", async () => {
    const plan = await bundledFontPlan();
    const base: Omit<TemplateInput, "width" | "height"> = {
      headline: "Every AI answer that mentions you, *in one place*",
      eyebrow: "Product update",
      subline: "Track citations across seven engines.",
      footer: "example.com",
      accent: "#7C5CFF",
      brandName: "Example",
      logo: PIXEL,
      screenshot: PIXEL,
      art: PIXEL,
      fonts: { heading: plan.heading, body: plan.body },
    };
    for (const [name, tpl] of Object.entries({ productNoir, headlineCard, titleCard, artOverlay })) {
      for (const [size, { width, height }] of Object.entries(RENDER_SIZES)) {
        const png = await renderPng(tpl({ ...base, width, height }), { width, height, fonts: plan.fonts });
        expect(png, `${name} ${size}`).not.toBeNull();
        expect([png!.readUInt32BE(16), png!.readUInt32BE(20)], `${name} ${size}`).toEqual([width, height]);
      }
    }
  }, 60_000);

  it("Product noir without a screenshot, and with no logo, still draws", async () => {
    const plan = await bundledFontPlan();
    const { width, height } = RENDER_SIZES.square;
    const png = await renderPng(
      productNoir({ width, height, headline: "4,235 links in one day", accent: "#22C55E", brandName: "Example", fonts: { heading: "Inter", body: "Inter" } }),
      { width, height, fonts: plan.fonts },
    );
    expect(png).not.toBeNull();
  });
});

describe("headline words", () => {
  it("stars mark the highlight; without stars a number and the word after it", () => {
    expect(headlineWords("Then it *vanished.*")).toEqual([
      { text: "Then", highlight: false },
      { text: "it", highlight: false },
      { text: "vanished.", highlight: true },
    ]);
    expect(headlineWords("Five *minutes to* value").filter((w) => w.highlight).map((w) => w.text)).toEqual(["minutes", "to"]);
    expect(headlineWords("We grew 42% faster this year").filter((w) => w.highlight).map((w) => w.text)).toEqual(["42%", "faster"]);
    expect(headlineWords("No numbers here at all").some((w) => w.highlight)).toBe(false);
  });

  it("cuts a long headline at a word, and sizes by length", () => {
    const words = headlineWords("word ".repeat(60));
    expect(words.map((w) => w.text).join(" ").length).toBeLessThanOrEqual(140);
    expect(words.at(-1)!.text.endsWith("…")).toBe(true);
    expect(sizeFor(10, 100, 40)).toBe(100);
    expect(sizeFor(96, 100, 40)).toBe(50);
    expect(sizeFor(400, 100, 40)).toBe(40);
  });

  it("picks ink that reads on the accent, and weights Satori accepts", () => {
    expect(inkOn("#FFE066")).toBe("#111114");
    expect(inkOn("#5B4FE6")).toBe("#FFFFFF");
    expect([toFontWeight(650), toFontWeight(1200), toFontWeight(undefined)]).toEqual([700, 900, 400]);
  });
});
