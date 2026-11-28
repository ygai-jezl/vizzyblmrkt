import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RaiseDocSummary } from "@/lib/raise/docs/types";
import { CARD_WORDS, LIST_WORDS, RAISE_MESSAGES } from "@/lib/raise/docs/words";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { RaiseKitList, listState } = await import("./RaiseKitList");
const { RaiseKitCard } = await import("./RaiseKitCard");

const NOW = new Date("2026-11-26T10:00:00.000Z");
const deck = (over: Partial<RaiseDocSummary> = {}): RaiseDocSummary => ({
  id: "rd_acme00000001",
  title: "Acme pre-seed",
  audience: "investor",
  stage: "pre_seed",
  kindLabel: "Investor deck, pre-seed",
  status: "draft",
  version: 3,
  slideCount: 10,
  talkSeconds: 240,
  updatedAt: "2026-11-25T09:00:00.000Z",
  ...over,
});
const html = (p: Partial<Parameters<typeof RaiseKitList>[0]> = {}) =>
  renderToStaticMarkup(createElement(RaiseKitList, { docs: [], granted: true, isAdmin: true, limit: 20, plansUi: false, now: NOW, ...p }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

describe("Content › Raise kit", () => {
  it("shows New deck to an admin whose plan includes it, with the three kinds", () => {
    const out = html();
    expect(out).toContain(LIST_WORDS.title);
    expect(out).toContain(LIST_WORDS.intro);
    expect(out).toContain(LIST_WORDS.legend);
    expect(out).toContain(LIST_WORDS.preSeed);
    expect(out).toContain(LIST_WORDS.seed);
    expect(out).toContain(LIST_WORDS.lender);
    expect(out).toContain(LIST_WORDS.lenderLine);
    expect(out).toContain(LIST_WORDS.briefPlaceholder);
    expect(out).toContain(LIST_WORDS.make);
    expect(out).toContain(LIST_WORDS.empty);
  });

  it("lists each deck with its kind, version, slides and date, linking to its studio", () => {
    const out = html({ docs: [deck(), deck({ id: "rd_fern00000001", title: "Fernhill stock loan", audience: "lender", stage: "loan", kindLabel: "Lender pack", version: 1, slideCount: 5 })] });
    expect(out).toContain('href="/admin/raise/rd_acme00000001"');
    expect(out).toContain("Investor deck, pre-seed");
    expect(out).toContain("Draft, version 3");
    expect(out).toContain("10 slides");
    expect(out).toContain("Changed 25 Nov");
    expect(out).toContain("Lender pack");
    expect(out).not.toContain(LIST_WORDS.empty);
  });

  it("says the Raise kit isn't included, linking to Plan and usage only while plans are on, and keeps the decks", () => {
    const out = html({ granted: false, docs: [deck()], plansUi: true });
    expect(out).toContain(RAISE_MESSAGES.notIncluded);
    expect(out).toContain(LIST_WORDS.plansLink);
    expect(out).not.toContain(LIST_WORDS.make);
    expect(out).toContain("Acme pre-seed");
    expect(html({ granted: false })).not.toContain(LIST_WORDS.plansLink);
  });

  it("tells a member they can open, present and save, with no New deck", () => {
    const out = html({ isAdmin: false, docs: [deck()] });
    expect(out).toContain(RAISE_MESSAGES.memberOnly);
    expect(out).not.toContain(LIST_WORDS.make);
  });

  it("stops New deck at the limit", () => {
    const docs = Array.from({ length: 20 }, (_, i) => deck({ id: `rd_acme${String(i).padStart(8, "0")}` }));
    const out = html({ docs });
    expect(out).toContain(RAISE_MESSAGES.deckLimit);
    expect(out).not.toContain(LIST_WORDS.make);
    expect(listState({ docs, granted: true, isAdmin: true, limit: 20 })).toMatchObject({ canMake: false, atLimit: true });
    expect(listState({ docs: [], granted: true, isAdmin: true, limit: 20 }).canMake).toBe(true);
  });
});

describe("the Raise kit card on Content", () => {
  it("counts the decks and links to the list", () => {
    const out = renderToStaticMarkup(createElement(RaiseKitCard, { count: 2 }));
    expect(out).toContain(CARD_WORDS.title);
    expect(out).toContain(CARD_WORDS.line);
    expect(out).toContain("2 decks");
    expect(out).toContain('href="/admin/raise"');
    expect(renderToStaticMarkup(createElement(RaiseKitCard, { count: 0 }))).toContain("No decks yet");
  });
});
