import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "@/lib/review/summary";
import type { WorkReviewPayload } from "@/lib/work/reviewCards";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { WorkCheckRowView, WorkReadyRowView, WorkRow, WorkSuggestionRowView, checkCardButtons, suggestionButtons } = await import("./WorkRows");

// Review's Work rows: Checks due today, Ready to start and Tasks Vizzy suggests. Made-up Lumen.
type Item<K extends WorkReviewPayload["kind"]> = ReviewItem & { work: Extract<WorkReviewPayload, { kind: K }> };
const ID = `aa_${"7".repeat(40)}` as const;
const measureCheck: Item<"check"> = {
  id: "work_check:wt_a",
  kind: "work_check",
  title: "#57 Templates for meeting notes",
  detail: "Lumen Notes · Did it work? Used: note_from_template events, 14 days after it's done. Work counted 212 note_from_template events from Lumen Notes' product since 11 Nov.",
  href: "/admin/work/57",
  action: "Open",
  work: { kind: "check", ref: 57, measure: true, setAt: "2026-11-24T13:00:00.000Z" },
};
const dateCheck: Item<"check"> = { ...measureCheck, id: "work_check:wt_b", title: "#69 Nightly check of search answers", detail: "After last night's runs.", href: "/admin/work/69", work: { kind: "check", ref: 69, measure: false, setAt: "2026-11-23T08:00:00.000Z" } };
const ready: Item<"ready"> = { id: "work_ready:wt_c", kind: "work_ready", title: "#80 Import from other note apps", detail: "1 Idea · Lumen Notes · To do since 18 Nov. Nothing blocks it.", href: "/admin/work/80", action: "Open", work: { kind: "ready", ref: 80, title: "Import from other note apps" } };
const suggestion: Item<"suggestion"> = {
  id: `aa:${ID}`,
  kind: "work_suggestion",
  title: "Answer “Does Lumen work offline?” on your site",
  detail: "From your numbers",
  href: `/admin/work/new?suggestion=${ID}`,
  action: "Edit then add",
  work: {
    kind: "suggestion",
    actionId: ID,
    rev: 1,
    title: "Answer “Does Lumen work offline?” on your site",
    stage: { n: 5, label: "Market" },
    brand: "Lumen Notes",
    ideas: ["Offline mode"],
    from: "From your numbers",
    why: "41 searches asked it last month, and no page of yours answers it.",
    measure: { text: "Moves a number: search clicks up, 28 days after it's done.", why: "It answers a question people search for." },
    editHref: `/admin/work/new?suggestion=${ID}`,
  },
};

/** Each button's and link's words, and whether it waits, in the order drawn. */
function controlsIn(html: string): Array<{ text: string; disabled: boolean }> {
  return [...html.matchAll(/<(button|a)([^>]*)>([^<]*)<\/\1>/g)].map((m) => ({ text: m[3]!, disabled: /\sdisabled=""/.test(m[2]!) || /aria-disabled="true"/.test(m[2]!) }));
}
const words = (html: string) => controlsIn(html).map((c) => c.text);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const draw = (el: (props: any) => unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(el as never, props as never));

describe("a check due", () => {
  it("on a measure asks for the read, with what Work counted, and Open", () => {
    const html = draw(WorkCheckRowView, { item: measureCheck, busy: null, error: null, onTap: () => {} });
    expect(html).toContain("Work counted 212 note_from_template events");
    expect(html).toContain("Your read:");
    expect(words(html)).toEqual(["Better", "Same", "Worse", "Too soon to tell", "Open"]);
    expect(html).toContain('href="/admin/work/57"');
  });

  it("on a date has Done and Tomorrow, never a read", () => {
    const html = draw(WorkCheckRowView, { item: dateCheck, busy: null, error: null, onTap: () => {} });
    expect(words(html)).toEqual(["Done", "Tomorrow", "Open"]);
    expect(html).not.toContain("Your read:");
  });

  it("waits while one is sent: that one says so and the others keep their words", () => {
    expect(checkCardButtons(true, "same")).toEqual([
      { key: "better", label: "Better", disabled: true },
      { key: "same", label: "Saving…", disabled: true },
      { key: "worse", label: "Worse", disabled: true },
      { key: "too_soon", label: "Too soon to tell", disabled: true },
    ]);
    expect(checkCardButtons(false, null)).toEqual([
      { key: "checked", label: "Done", disabled: false },
      { key: "look_again", label: "Tomorrow", disabled: false },
    ]);
  });
});

describe("a task ready to start", () => {
  it("has Start and Open", () => {
    const html = draw(WorkReadyRowView, { item: ready, busy: false, error: null, onStart: () => {} });
    expect(words(html)).toEqual(["Start", "Open"]);
    expect(html).toContain("To do since 18 Nov. Nothing blocks it.");
    expect(controlsIn(draw(WorkReadyRowView, { item: ready, busy: true, error: null, onStart: () => {} }))[0]).toEqual({ text: "Starting…", disabled: true });
  });
});

describe("a task Vizzy suggests", () => {
  it("shows its stage, brand, idea, where it came from, why, and how we'll know it worked, with Dismiss, Edit then add and Add to Work", () => {
    const html = draw(WorkSuggestionRowView, { item: suggestion, busy: null, asking: false, error: null, onAdd: () => {}, onDismiss: () => {}, onWhy: () => {}, onCancel: () => {} });
    expect(html).toContain("Market");
    expect(html).toContain("Lumen Notes");
    expect(html).toContain("Offline mode");
    expect(html).toContain("From your numbers");
    expect(html).toContain("41 searches asked it last month");
    expect(html).toContain("How we&#x27;ll know:</span> Moves a number: search clicks up, 28 days after it&#x27;s done. It answers a question people search for.");
    expect(words(html)).toEqual(["Dismiss", "Edit then add", "Add to Work"]);
    expect(html).toContain(`href="/admin/work/new?suggestion=${ID}"`);
  });

  it("asks why on Dismiss, with the four reasons, No reason and Cancel", () => {
    const html = draw(WorkSuggestionRowView, { item: suggestion, busy: null, asking: true, error: null, onAdd: () => {}, onDismiss: () => {}, onWhy: () => {}, onCancel: () => {} });
    expect(html).toContain("Why dismiss it?");
    expect(words(html)).toEqual(["Not now", "Not for us", "Already on it", "Wrong", "No reason", "Cancel"]);
  });

  it("waits while one is sent", () => {
    expect(suggestionButtons("add")).toEqual({ add: { label: "Adding…", disabled: true }, dismiss: { label: "Dismiss", disabled: true } });
    const html = draw(WorkSuggestionRowView, { item: suggestion, busy: "add", asking: false, error: "That suggestion was added or dismissed already. Refresh Review to see what's waiting.", onAdd: () => {}, onDismiss: () => {}, onWhy: () => {}, onCancel: () => {} });
    expect(controlsIn(html)).toEqual([
      { text: "Dismiss", disabled: true },
      { text: "Edit then add", disabled: true },
      { text: "Adding…", disabled: true },
    ]);
    expect(html).toContain('role="alert"');
  });
});

describe("WorkRow", () => {
  it("draws each kind by its payload, starting with nothing sent", () => {
    expect(words(draw(WorkRow, { item: measureCheck }))).toEqual(["Better", "Same", "Worse", "Too soon to tell", "Open"]);
    expect(words(draw(WorkRow, { item: ready }))).toEqual(["Start", "Open"]);
    expect(words(draw(WorkRow, { item: suggestion }))).toEqual(["Dismiss", "Edit then add", "Add to Work"]);
  });
});
