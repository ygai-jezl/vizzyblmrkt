import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DraftedDecision, DraftedNote } from "@/lib/work/screens";

// What a person sees on opening a draft of Vizzy's from the chat's card. Made-up Lumen Notes.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/work/1" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { Decisions, DraftedDecisionBox } = await import("./Decisions");
const { LogBox } = await import("./WorkLog");

const DRAFT: DraftedDecision = {
  id: `aa_${"1".repeat(40)}`,
  rev: 1,
  question: "Which supplier first?",
  options: [
    { id: "a", label: "Clay and Co" },
    { id: "b", label: "Fernhill Pots" },
  ],
  recommended: { option: "b", reason: "They deliver weekly." },
};

describe("a decision Vizzy drafted", () => {
  it("shows the question, the options with Vizzy's pick and why, and asks the person to choose", () => {
    const html = renderToStaticMarkup(createElement(DraftedDecisionBox, { taskRef: 1, draft: DRAFT }));
    expect(html).toContain("Vizzy drafted this decision. Nothing is recorded until you choose.");
    expect(html).toContain("Which supplier first?");
    expect(html).toContain("Clay and Co");
    expect(html).toMatch(/Fernhill Pots.*Vizzy&#x27;s pick/);
    expect(html).toContain("Vizzy recommended “Fernhill Pots”.");
    expect(html).toContain("They deliver weekly.");
    // Nothing is chosen for the person: Save waits for their pick.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save the decision<\/button>/);
    expect(html).toContain("Leave it");
  });

  it("sits above the task's decisions, or says why it can't be chosen on", () => {
    const base = { taskRef: 1, decisions: [], typedLinks: [], me: "uid_nina", names: {}, timeZone: "UTC", today: "2026-11-20" };
    expect(renderToStaticMarkup(createElement(Decisions, { ...base, drafted: DRAFT }))).toContain('id="decisions"');
    const gone = renderToStaticMarkup(createElement(Decisions, { ...base, drafted: { gone: "That decision from Vizzy was saved already." } }));
    expect(gone).toContain("That decision from Vizzy was saved already.");
    expect(gone).not.toContain("Save the decision");
  });
});

describe("a Log note Vizzy drafted", () => {
  const screen = { openTasks: [{ ref: 1, title: "Pick a pottery supplier", status: "todo" as const }], logBrands: [{ id: "ten_lumen", name: "Lumen Notes" }], wholeBusiness: false, multiBrand: false, sessionBrand: { id: "ten_lumen", name: "Lumen Notes" } };
  const note: DraftedNote = { id: `aa_${"2".repeat(40)}`, rev: 1, line: "Supplier calls: Called two", state: "done", ref: 1, brandId: "ten_lumen", links: [] };

  it("fills the Log box, says nothing is logged until it's saved, and saves to today's log", () => {
    const html = renderToStaticMarkup(createElement(LogBox, { screen: screen as never, draft: note }));
    expect(html).toContain("Vizzy drafted this note. Nothing is in the Log until you save it, and you can change it first.");
    expect(html).toContain('value="Supplier calls: Called two"');
    expect(html).toMatch(/<option value="done" selected="">Done<\/option>/);
    expect(html).toMatch(/<option value="1" selected="">#1 Pick a pottery supplier<\/option>/);
    expect(html).toContain("Save to today&#x27;s log");
    expect(html).toContain("Leave it");
  });

  it("is the plain Log box without one", () => {
    const html = renderToStaticMarkup(createElement(LogBox, { screen: screen as never }));
    expect(html).toContain("Log it");
    expect(html).not.toContain("Vizzy drafted");
  });
});
