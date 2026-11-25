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
  });

  it("with voice on, leads with Talk with Vizzy, then the questions, Skip and the words footer", () => {
    const html = render(true, WelcomeScreen);
    const order = ["Talk with Vizzy", "Fastest", "By voice, 3 to 5 minutes", "Talking it through gets you value", "Or answer 4 quick questions", "Skip for now", "Vizzy keeps the words, never the audio. Read or delete them in Settings."];
    const at = order.map((w) => html.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
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
