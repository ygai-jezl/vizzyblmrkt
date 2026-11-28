import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LOOPS_COPY, loopsData } from "@/lib/loops/loopsSection";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never) }));

const { LoopsSection } = await import("./LoopsSection");
const { SaveError } = await import("./LearningSettingCard");

/** Settings › Learning loops and Help check that learning works, as screen readers get them. */

const NOW = new Date("2027-05-12T09:00:00.000Z");
const W = "2027-W18";

describe("How far each kind gets", () => {
  it("heads each kind's rows with the kind, so a plan row's cells are read with it", () => {
    const data = loopsData({ week: W, orgs: { orgs: 20, p: { free: 12, pro: 6, ultra: 2 } }, rows: new Map() }, { meterOn: true, today: NOW, docsUrl: "https://example.test/docs" });
    const html = renderToStaticMarkup(createElement(LoopsSection, { view: { state: "data", data, weeks: [] } }));
    expect(html).toContain(LOOPS_COPY.stagesHead[0]!);
    const table = html.match(/<table[^>]*aria-labelledby="loops-stages-h"[^>]*>(.*?)<\/table>/s)![1]!;
    const groups = [...table.matchAll(/<tbody[^>]*>(.*?)<\/tbody>/gs)].map((m) => m[1]!);
    expect(groups.length).toBe(data.stages.length);
    expect(data.stages.some((k) => k.plans.length > 0)).toBe(true);
    for (const [i, body] of groups.entries()) {
      const heads = [...body.matchAll(/<th scope="(\w+)"/g)].map((m) => m[1]);
      // The kind is the row group's head, each plan the head of its own row.
      expect(heads, data.stages[i]!.label).toEqual(["rowgroup", ...data.stages[i]!.plans.map(() => "row")]);
    }
  });
});

describe("Help check that learning works", () => {
  it("announces why a change didn't save, and shows nothing without an error", () => {
    expect(renderToStaticMarkup(createElement(SaveError, { error: "Couldn't save. Try again." }))).toMatch(/^<p role="alert"[^>]*>Couldn&#x27;t save\. Try again\.<\/p>$/);
    expect(renderToStaticMarkup(createElement(SaveError, { error: null }))).toBe("");
  });
});
