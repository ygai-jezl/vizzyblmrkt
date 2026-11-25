import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { OnboardingFrame } = await import("./OnboardingFrame");
const { WelcomeScreen } = await import("./WelcomeScreen");
const { QuickQuestions } = await import("./QuickQuestions");

const render = (voice: boolean, screen: (props: object) => ReactNode, answers = {}) =>
  renderToStaticMarkup(
    createElement(OnboardingFrame, { brand: { name: "Fernhill Plants", faviconUrl: "" }, voice, answers }, createElement(screen)),
  ).replace(/&#x27;/g, "'");

describe("the welcome", () => {
  it("covers the shell as a dialog with the brand top left", () => {
    const html = render(false, WelcomeScreen);
    expect(html).toMatch(/^<div[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Welcome"/);
    expect(html).toContain("fixed inset-0 z-40");
    expect(html).toContain("Fernhill Plants");
  });

  it("with voice off, makes the 4 quick questions the main choice, keeps Skip, and drops the voice words", () => {
    const html = render(false, WelcomeScreen);
    expect(html).toContain("Hi, I'm Vizzy, your AI co-founder");
    expect(html).toContain("Tell me about Fernhill Plants and I'll suggest your first steps.");
    expect(html).toMatch(/<a href="\/admin\/welcome\/questions"[^>]*>.*Answer 4 quick questions/);
    expect(html).toContain("Skip for now");
    for (const gone of ["Talk with Vizzy", "Fastest", "By voice", "Talking it through", "Or answer 4 quick questions", "never the audio"]) {
      expect(html).not.toContain(gone);
    }
    // A plain card: the turning gradient border is Talk with Vizzy's own.
    expect(html).not.toContain("yg-talk");
  });

  it("with voice on, leads with Talk with Vizzy, then the questions, Skip and the words footer", () => {
    const html = render(true, WelcomeScreen);
    const order = ["Talk with Vizzy", "Fastest", "By voice, 3 to 5 minutes", "Talking it through gets you value", "Or answer 4 quick questions", "Skip for now", "Vizzy keeps the words, never the audio. Read or delete them in Settings."];
    const at = order.map((w) => html.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("gives Talk with Vizzy the gradient border on a card coloured button, with the Fastest badge", () => {
    const html = render(true, WelcomeScreen);
    const talk = html.match(/<button type="button" class="([^"]*)">(.*?)<\/button>/)!;
    expect(talk[1]).toMatch(/^yg-talk /);
    // Card coloured with ink text comes from yg-talk (globals.css): never a black fill.
    expect(talk[1]).not.toMatch(/bg-shell-ink|bg-black/);
    expect(talk[2]).toContain("Talk with Vizzy");
    expect(talk[2]).toMatch(/<span class="[^"]*">Fastest<\/span>/);
    expect(talk[2]).toContain("By voice, 3 to 5 minutes");
    expect(html.match(/yg-talk/g)).toHaveLength(1);
  });

  it("styles the border to turn in 6 s and glow every 2.4 s, on the card colour, and keeps still under reduced motion", () => {
    const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
    expect(css).toMatch(/@property --ob-angle \{\s*syntax: "<angle>";\s*inherits: false;\s*initial-value: 0deg;\s*\}/);
    const talk = css.slice(css.indexOf(".yg-talk {"), css.indexOf("}", css.indexOf(".yg-talk {")));
    expect(talk).toContain("linear-gradient(var(--yg-card), var(--yg-card)) padding-box");
    expect(talk).toContain("conic-gradient(from var(--ob-angle), #2563eb, #7c3aed, #db2777, #f59e0b, #2563eb) border-box");
    expect(talk).toContain("color: var(--yg-ink)");
    expect(talk).toMatch(/yg-ob-turn 6s linear infinite/);
    expect(talk).toMatch(/yg-ob-pulse 2\.4s ease-in-out infinite/);
    const still = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(still).toMatch(/\.yg-talk,[\s\S]*animation: none/);
  });
});

describe("the 4 quick questions", () => {
  it("start on Who are you? with keys 1 to 3, Back to the welcome by a whole page load, and Skip", () => {
    const html = render(false, QuickQuestions);
    expect(html).toContain("1 of 4");
    expect(html).toContain("Who are you?");
    expect(html).toContain("Pick one. You can change it later.");
    expect(html).toMatch(/<kbd aria-hidden="true"[^>]*>1<\/kbd>/);
    expect(html).toMatch(/<a href="\/admin\/welcome" [^>]*>.*Back<\/a>/);
    expect(html).toContain("Skip");
    expect(html).not.toContain("Your answers so far");
  });

  it("show answers already saved as the answers so far", () => {
    const html = render(false, QuickQuestions, { who: "agency" });
    expect(html).toContain('aria-label="Your answers so far"');
    expect(html).toContain("An agency, for clients");
  });
});
