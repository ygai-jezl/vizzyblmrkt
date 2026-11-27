import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LAYOUT_KEYS, type Slide } from "@/lib/raise/docs/types";
import { NOW } from "@/lib/raise/docs/testing/fixtures";
import { THEME, acmeSlides, fernhillView } from "@/lib/raise/docs/testing/view";
import { chartSource } from "./DeckChart";
import { deckFontCss } from "./DeckFonts";
import { initialsOf } from "./layouts/parts";
import { SlideView, type SlideMode } from "./SlideView";

const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const draw = (slide: Slide, mode: SlideMode = "print", over: Partial<Parameters<typeof SlideView>[0]> = {}) =>
  decode(
    renderToStaticMarkup(
      createElement(SlideView, { slide, theme: THEME, n: 1, total: 10, title: "Acme pre-seed", audience: "investor", stage: "pre_seed", mode, now: NOW, ...over }),
    ),
  );
/** The words a slide shows, without its markup. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("a slide", () => {
  const slides = acmeSlides();
  const of = (layout: string) => slides.find((s) => s.layout === layout)!;

  it("has a fixture for every layout", () => {
    expect(new Set(slides.map((s) => s.layout))).toEqual(new Set(LAYOUT_KEYS));
  });

  it("draws at 1280 by 720 with the logo in the corner, except the cover where it is large", () => {
    const html = draw(of("statement"));
    expect(html).toContain("width:1280px");
    expect(html).toContain("height:720px");
    expect(html).toContain('src="/api/brand-logo/ten_acme/logo-0001.png"');
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(draw(of("cover")).match(/max-height:120px/)).not.toBeNull();
  });

  it("shows each layout's real words: headline, points, people and columns", () => {
    expect(words(draw(of("cover")))).toContain("Acme Stock counts for small shops, done in minutes");
    expect(words(draw(of("statement")))).toContain("Shop owners lose a day a week counting stock");
    expect(words(draw(of("statement")))).toContain("Most still count on paper");
    const three = words(draw(of("three_points")));
    for (const p of ["Scan as you shelve", "Counts update with each sale", "Reorders drafted for you"]) expect(three).toContain(p);
    const compare = words(draw(of("compare")));
    for (const p of ["What people do today", "With Acme", "Count on Sunday", "Counted as you sell"]) expect(compare).toContain(p);
    const team = words(draw(of("team")));
    for (const p of ["Sam Rivera", "Chief executive", "Ran three shops.", "SR", "AC"]) expect(team).toContain(p);
    expect(words(draw(of("ask")))).toContain("It gets us to 1,000 paying shops");
  });

  it("puts each number in from its block, with its name and where it came from", () => {
    const chart = words(draw(of("chart")));
    expect(chart).toContain("4,310 people joined the waitlist in 12 weeks to 26 Nov");
    expect(chart).toContain("Sign-ups a week, 12 weeks to 26 Nov. Seen by YouGrow.");
    expect(chart).toContain("Seen by YouGrow, 26 Nov");
    expect(chart).not.toContain("{{");
    const big = words(draw(of("big_number")));
    expect(big).toContain("320,000");
    expect(big).toContain("Shops in the UK");
    expect(big).toContain("Typed by you, from a trade body report, 26 Nov");
  });

  it("shows a typed number said in chat as said in chat", () => {
    const s = of("big_number");
    const said = { ...s, blocks: [{ ...s.blocks[0]!, source: { ...s.blocks[0]!.source, saidInChat: true, quote: "We have 320,000 shops" } }] };
    expect(words(draw(said))).toContain("said in chat");
  });

  it("carries the version footer on the last slide only", () => {
    const s = of("ask");
    expect(words(draw(s, "print", { n: 10, total: 10, version: { n: 4, at: NOW.toISOString() } }))).toContain("Version 4, 26 Nov");
    expect(words(draw(s, "print", { n: 9, total: 10, version: { n: 4, at: NOW.toISOString() } }))).not.toContain("Version 4");
  });

  it("shows Needs in the studio only, never in Present, the PDF or a thumbnail", () => {
    const s = of("ask");
    expect(words(draw(s, "edit"))).toContain("Needs: how much you're raising. Add it here or tell Vizzy.");
    for (const mode of ["present", "print", "thumb"] as const) expect(words(draw(s, mode))).not.toContain("Needs:");
    expect(draw(s, "edit", { onDismissNeed: () => undefined })).toContain("Dismiss");
    expect(draw(s, "edit")).not.toContain("Dismiss");
  });

  it("shows a number that isn't filled yet only in the studio, as Fills when you save", () => {
    const s: Slide = { ...of("big_number"), blocks: [{ ...of("big_number").blocks[0]!, meaning: "waitlistSignups", value: null, display: "", asOf: "", source: { kind: "insights" } }] };
    expect(words(draw(s, "edit"))).toContain("Fills when you save");
    expect(words(draw(s, "print"))).not.toContain("Fills when you save");
  });

  it("heads a lender pack's money slide with what the money is for and how it repays, in a shop's words", () => {
    const fern = fernhillView();
    const ask = { ...fern.slides[2]!, points: ["Spring plants", "A second greenhouse", "Shelving", "Paid back from summer sales"] };
    const html = words(draw(ask, "print", { audience: "lender", stage: "loan", theme: fern.theme, title: fern.title }));
    expect(html).toContain("What the money is for");
    expect(html).toContain("How it repays");
    expect(html).toContain("Paid back from summer sales");
    const sales = words(draw(fern.slides[1]!, "print", { audience: "lender", stage: "loan", theme: fern.theme }));
    expect(sales).toContain("£14,200 a month");
    expect(sales).toContain("Typed by you, from the shop's till, 26 Nov");
    // No logo: the brand's name in the corner.
    expect(sales).toContain("Fernhill Plants");
  });
});

describe("the pieces of a slide", () => {
  it("writes a chart's source line for YouGrow's numbers and typed ones", () => {
    expect(chartSource({ name: "Sign-ups a week", periodWords: "12 weeks to 23 Nov", source: { kind: "insights" } })).toBe("Sign-ups a week, 12 weeks to 23 Nov. Seen by YouGrow.");
    expect(chartSource({ name: "Monthly sales", source: { kind: "typed", from: "your till" } })).toBe("Monthly sales. Typed by you, from your till.");
    expect(chartSource({ name: "Monthly sales", source: { kind: "typed" } })).toBe("Monthly sales. Typed by you.");
  });

  it("makes initials from a name", () => {
    expect(initialsOf("Sam Rivera")).toBe("SR");
    expect(initialsOf("jo")).toBe("J");
    expect(initialsOf("  ")).toBe("?");
  });

  it("loads only the brand's own uploaded fonts, with safe names", () => {
    const css = deckFontCss([
      { family: "Acme Sans", url: "/api/brand-font/ten_acme/f1.woff2" },
      { family: "Bad');}body{x", url: "/api/brand-font/ten_acme/f2.woff2" },
      { family: "Elsewhere", url: "https://fonts.example/x.woff2" },
      { family: "Quote", url: "/api/brand-font/ten_acme/f'3.woff2" },
    ]);
    expect(css).toContain("@font-face{font-family:'Acme Sans';src:url('/api/brand-font/ten_acme/f1.woff2');font-display:swap;}");
    expect(css).toContain("font-family:'Badbodyx'");
    expect(css).not.toContain("fonts.example");
    expect(css).not.toContain("f'3");
  });
});
