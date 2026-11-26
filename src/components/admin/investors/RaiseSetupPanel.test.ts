import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SETUP_WORDS } from "@/lib/raise/pipeline/words";
import type { SetupPreview } from "./investorsApi";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { kitOrder, previewLines, SetupView } = await import("./RaiseSetupPanel");

// A plant shop that keeps its own Stage field: funding adds the fields it lacks and four stages.
const PLAN: SetupPreview["plan"] = {
  addFields: [
    { label: "Relationship", type: "select" },
    { label: "Firm", type: "text" },
  ],
  addOptions: [
    { field: "Relationship", label: "Investor" },
    { field: "Stage", label: "Plan" },
    { field: "Stage", label: "Applied" },
  ],
  adopt: [{ label: "Stage" }],
  kept: [{ label: "Tier", note: SETUP_WORDS.keptArchived("Tier") }],
  nothing: false,
};
const preview = (plan: SetupPreview["plan"] = PLAN): SetupPreview => ({ kit: "funding", currency: "GBP", firstKit: "funding", plan });
const view = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(SetupView, {
      preview: preview(),
      kit: "funding",
      currency: "GBP",
      busy: false,
      done: null,
      error: null,
      onKit: () => {},
      onCurrency: () => {},
      onPress: () => {},
      ...over,
    }),
  );

describe("Ready-made fields", () => {
  it("shows a shop's likelier kit first", () => {
    expect(kitOrder("funding")).toEqual(["funding", "raising"]);
    expect(kitOrder("raising")).toEqual(["raising", "funding"]);
  });

  it("previews what a press adds and keeps: the new fields on one line, then each field of yours that gains options", () => {
    expect(previewLines(PLAN)).toEqual({
      summary: "Adds 2 fields and 3 options.",
      lines: ["Relationship, Firm", "Stage: Plan, Applied"],
      keeps: SETUP_WORDS.keeps,
      notes: ["You archived ‘Tier’, so it stays archived. Bring it back in Data model if you want it."],
    });
  });

  it("says when everything is already here, and the button stays", () => {
    const nothing = { addFields: [], addOptions: [], adopt: [], kept: [], nothing: true };
    expect(previewLines(nothing)).toEqual({ summary: SETUP_WORDS.nothing, lines: [], keeps: null, notes: [] });
    const html = view({ preview: preview(nothing) });
    expect(html).toContain(SETUP_WORDS.nothing);
    expect(html).toContain(`>${SETUP_WORDS.kits.funding.button}</button>`);
  });

  it("draws both kits, the currency, the preview and the press", () => {
    const html = view();
    expect(html).toContain(SETUP_WORDS.title);
    expect(html).toContain(SETUP_WORDS.lead);
    expect(html.indexOf(SETUP_WORDS.kits.funding.line)).toBeLessThan(html.indexOf(SETUP_WORDS.kits.raising.line));
    expect(html).toContain(SETUP_WORDS.amountsIn);
    expect(html).toContain('<option value="GBP" selected="">GBP</option>');
    expect(html).toContain("Adds 2 fields and 3 options.");
    expect(view({ busy: true })).toContain(SETUP_WORDS.busy);
  });

  it("says where the board is after a press, with a link to it", () => {
    const html = view({ done: { message: SETUP_WORDS.done(10, 39), board: "funding", href: "/admin/crm?tab=investors" } });
    expect(html).toContain("Added 10 fields and 39 options.");
    expect(html).toContain(SETUP_WORDS.where("funding"));
    expect(html).toContain('href="/admin/crm?tab=investors"');
    expect(html).toContain(SETUP_WORDS.openBoard);
    expect(view({ done: { message: SETUP_WORDS.nothing, board: null, href: "/admin/crm?tab=investors" } })).not.toContain(SETUP_WORDS.openBoard);
    expect(view({ error: SETUP_WORDS.errors.fields_changed })).toContain(SETUP_WORDS.errors.fields_changed);
  });
});
