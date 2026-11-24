import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "@/lib/review/summary";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { SignalRow, SignalRowView, signalButtons } = await import("./SignalActions");

// Review's Plan an article and Dismiss on a suggestion from collected numbers. Made-up page and numbers.
const item = {
  id: "aa:aa_" + "1".repeat(40),
  kind: "data_signal",
  title: "Fewer Google clicks to /care/fiddle-leaf-fig",
  detail: "41 clicks in the 28 days to 20 Nov, down from 96 in the 28 days before.",
  details: ["41 clicks in the 28 days to 20 Nov, down from 96 in the 28 days before."],
  href: "/admin/approvals#data_signal",
  action: "Plan an article",
  signal: { id: "dsg_" + "a".repeat(24) },
} as unknown as ReviewItem & { signal: { id: string } };
const one = [{ id: "ws_blog", name: "Plant care blog" }];
const two = [...one, { id: "ws_news", name: "Newsletter" }];

/** Each button's words and whether it is disabled, in the order drawn. */
function buttonsIn(html: string): Array<{ text: string; disabled: boolean }> {
  return [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ text: m[2]!, disabled: /\sdisabled=""/.test(m[1]!) }));
}
const view = (busy: "approve" | "dismiss" | null, programmes = one) =>
  renderToStaticMarkup(createElement(SignalRowView, { item, programmes, programmeWord: "programme", busy, error: null, onPlan: () => {}, onDismiss: () => {} }));

describe("Plan an article and Dismiss", () => {
  it("each have their own busy state: the one sent says so, the other is disabled with its words unchanged", () => {
    expect(signalButtons(null)).toEqual({ plan: { label: "Plan an article", disabled: false }, dismiss: { label: "Dismiss", disabled: false } });
    expect(signalButtons("approve")).toEqual({ plan: { label: "Planning…", disabled: true }, dismiss: { label: "Dismiss", disabled: true } });
    expect(signalButtons("dismiss")).toEqual({ plan: { label: "Plan an article", disabled: true }, dismiss: { label: "Dismissing…", disabled: true } });
  });

  it("draws the row as each state says", () => {
    expect(buttonsIn(view(null))).toEqual([
      { text: "Dismiss", disabled: false },
      { text: "Plan an article", disabled: false },
    ]);
    expect(buttonsIn(view("dismiss"))).toEqual([
      { text: "Dismissing…", disabled: true },
      { text: "Plan an article", disabled: true },
    ]);
    expect(buttonsIn(view("approve"))).toEqual([
      { text: "Dismiss", disabled: true },
      { text: "Planning…", disabled: true },
    ]);
    // With several programmes, the choice waits too while Dismiss runs, and keeps its words.
    const several = view("dismiss", two);
    expect(several).toContain('aria-disabled="true"');
    expect(several).toMatch(/<summary[^>]*>Plan an article<\/summary>/);
    expect(buttonsIn(several).slice(1)).toEqual([
      { text: "Plant care blog", disabled: true },
      { text: "Newsletter", disabled: true },
    ]);
    expect(view(null, two)).not.toContain("aria-disabled");
  });

  it("starts with neither sent", () => {
    const html = renderToStaticMarkup(createElement(SignalRow, { item, programmes: one, programmeWord: "programme" }));
    expect(buttonsIn(html)).toEqual([
      { text: "Dismiss", disabled: false },
      { text: "Plan an article", disabled: false },
    ]);
    expect(html).toContain("41 clicks in the 28 days to 20 Nov");
  });
});
