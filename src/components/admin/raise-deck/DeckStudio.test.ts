import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { acmeView, fernhillView } from "@/lib/raise/docs/testing/view";
import { EDITOR_WORDS, GUIDANCE, LENDER_GUIDANCE, RAISE_MESSAGES, SLIDE_RULES, STUDIO_WORDS } from "@/lib/raise/docs/words";

const shell = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) => h("a", { href, ...rest }, children as never) };
});
vi.mock("@/components/admin/nav/ShellProvider", () => ({ useShell: () => shell.current }));
const { DeckStudio } = await import("./DeckStudio");

type Props = Parameters<typeof DeckStudio>[0];
const html = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(createElement(DeckStudio, { initial: acmeView(), vizzy: false, brandHref: "/admin/brand-kit", ...over }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

describe("the deck studio", () => {
  it("shows the deck's name, kind, version and look, with the slides down the side", () => {
    const out = html();
    expect(out).toContain('aria-label="Deck name"');
    expect(out).toContain('value="Acme pre-seed"');
    expect(out).toContain("Investor deck, pre-seed");
    expect(out).toContain("Draft, version 3");
    expect(out).toContain(STUDIO_WORDS.look);
    expect(out).toContain(STUDIO_WORDS.more);
    for (let n = 1; n <= 8; n += 1) expect(out).toContain(`Slide ${n}`);
    for (const a of [STUDIO_WORDS.addSlide, STUDIO_WORDS.moveUp, STUDIO_WORDS.moveDown, STUDIO_WORDS.removeSlide]) expect(out).toContain(a);
  });

  it("opens on the first slide with its words to change and its This slide tab", () => {
    const out = html();
    expect(out).toContain(EDITOR_WORDS.headline);
    expect(out).toContain(STUDIO_WORDS.speakerNotes);
    expect(out).toContain(STUDIO_WORDS.insertNumber);
    for (const t of Object.values(STUDIO_WORDS.tabs)) expect(out).toContain(t);
    expect(out).toContain(GUIDANCE.cover);
    for (const r of SLIDE_RULES) expect(out).toContain(r);
  });

  it("opens the slide brand search linked, with its Needs callout and Dismiss", () => {
    const out = html({ initialSlide: 7 });
    expect(out).toContain("Needs: how much you're raising. Add it here or tell Vizzy.");
    expect(out).toContain(STUDIO_WORDS.dismiss);
    expect(out).toContain(GUIDANCE.ask);
  });

  it("lets a member read, present and save, but not change", () => {
    const out = html({ initial: acmeView({ canEdit: false, canDraft: false }), initialSlide: 7 });
    expect(out).not.toContain('aria-label="Deck name"');
    expect(out).toContain("<h1");
    expect(out).not.toContain(STUDIO_WORDS.addSlide);
    expect(out).not.toContain(STUDIO_WORDS.insertNumber);
    expect(out).not.toContain(STUDIO_WORDS.dismiss);
    expect(out).not.toContain(STUDIO_WORDS.delete);
  });

  it("says when New deck saved the outline without Vizzy's words", () => {
    expect(html({ outlineNotice: true })).toContain(RAISE_MESSAGES.outlineOnly);
    expect(html()).not.toContain(RAISE_MESSAGES.outlineOnly);
  });

  it("offers Ask Vizzy to change this slide only while Vizzy can work on decks and the admin can draft", () => {
    shell.current = { ask: vi.fn(), setVizzyOpen: vi.fn(), onCanvasSaved: null };
    try {
      expect(html({ vizzy: true })).toContain(STUDIO_WORDS.askPlaceholder);
      expect(html({ vizzy: true })).toContain(STUDIO_WORDS.askVizzy);
      expect(html({ vizzy: false })).not.toContain(STUDIO_WORDS.askPlaceholder);
      expect(html({ vizzy: true, initial: acmeView({ canDraft: false }) })).not.toContain(STUDIO_WORDS.askPlaceholder);
    } finally {
      shell.current = null;
    }
    expect(html({ vizzy: true })).not.toContain(STUDIO_WORDS.askPlaceholder);
  });

  it("uses a lender's guidance on a lender pack", () => {
    const out = html({ initial: fernhillView() });
    expect(out).toContain("Lender pack");
    expect(out).toContain(LENDER_GUIDANCE.cover);
  });
});
