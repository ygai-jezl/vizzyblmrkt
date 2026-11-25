import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { VOICE_WORDS } from "@/lib/onboarding/words";
import { topicStates } from "@/lib/onboarding/voice/topics";
import { INITIAL_VOICE_VIEW, type VoiceCall as VoiceCallState } from "@/lib/onboarding/voice/useVoiceCall";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { OnboardingFrame } = await import("./OnboardingFrame");
const { LiveClock, VoiceCall } = await import("./VoiceCall");

const noop = () => {};
const call = (over: Partial<VoiceCallState>): VoiceCallState => ({ ...INITIAL_VOICE_VIEW, start: noop, end: noop, toggleMute: noop, ...over });
const render = (node: ReactNode) =>
  renderToStaticMarkup(createElement(OnboardingFrame, { brand: { name: "Fernhill Plants", faviconUrl: "" }, voice: true, answers: {} }, node))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

describe("Allow your microphone", () => {
  it("waits on the browser's own prompt, with the questions as the way out", () => {
    const html = render(createElement(VoiceCall, { call: call({ phase: "mic" }) }));
    const order = ["Allow your microphone", "Your browser asks once. Vizzy listens only on this page.", "Answer 4 quick questions instead", "Vizzy keeps the words, never the audio."];
    const at = order.map((w) => html.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toMatch(/<a href="\/admin\/welcome\/questions"[^>]*>Answer 4 quick questions instead<\/a>/);
    expect(html).not.toContain('role="alert"');
  });

  it.each([
    ["blocked", VOICE_WORDS.blocked, "Allow your microphone"],
    ["used_today", VOICE_WORDS.usedToday, "Talk with Vizzy"],
    ["full", VOICE_WORDS.full, "Talk with Vizzy"],
    ["unavailable", VOICE_WORDS.unavailable, "Talk with Vizzy"],
  ] as const)("says why a call can't start (%s), as an alert", (problem, words, title) => {
    const html = render(createElement(VoiceCall, { call: call({ phase: "mic", problem }) }));
    expect(html).toContain(`<p role="alert" class="mt-2 text-pretty text-base text-shell-muted">${words}</p>`);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
    expect(html).not.toContain(VOICE_WORDS.micLead);
    expect(html).toContain("Answer 4 quick questions instead");
  });
});

describe("talking", () => {
  const transcript = {
    lines: [
      { who: "vizzy" as const, text: "Hi! Tell me about your shop.", atSec: 0 },
      { who: "member" as const, text: "We sell houseplants.", atSec: 4 },
    ],
    partial: { who: "member" as const, text: "And pots, mostly", atSec: 9 },
  };
  const topics = topicStates([
    { topic: "who", choice: "team" },
    { topic: "run", choice: "shop" },
    { topic: "stage", choice: "launched" },
  ]);

  it("lists the topics, ticked with their answers for screen readers, and the one now", () => {
    const html = render(createElement(VoiceCall, { call: call({ phase: "talking", topics, transcript }) }));
    expect(html).toContain('aria-label="What Vizzy makes sure it covers"');
    expect(html).toContain('Who you are<span class="sr-only"> (covered: A small team)</span>');
    expect(html).toContain('Where it is today<span class="sr-only"> (covered: Launched, finding first customers)</span>');
    expect(html).toContain('What you want first<span class="sr-only"> (talking about it now)</span>');
    expect(html).toContain("Listening");
    expect(html).toContain("Talk about anything else too. Vizzy keeps the words, never the audio.");
  });

  it("announces only finished lines: the line being heard sits outside the live region", () => {
    const html = render(createElement(VoiceCall, { call: call({ phase: "talking", topics, transcript }) }));
    const live = html.match(/<ol aria-live="polite" aria-label="Live transcript"[^>]*>(.*?)<\/ol>/)![1]!;
    expect(live).toContain("Hi! Tell me about your shop.");
    expect(live).toContain("We sell houseplants.");
    expect(live).not.toContain("And pots, mostly");
    expect(html).toMatch(/<\/ol><div[^>]*>.*You.*yg-caret[^>]*>And pots, mostly<\/span><\/div>/);
  });

  it("has Mute, pressed when muted, and End", () => {
    let html = render(createElement(VoiceCall, { call: call({ phase: "talking", topics, transcript }) }));
    expect(html).toMatch(/<button type="button" aria-label="Mute" aria-pressed="false"/);
    expect(html).toMatch(/<button type="button"[^>]*>.*End<\/button>/);
    html = render(createElement(VoiceCall, { call: call({ phase: "talking", topics, transcript, muted: true }) }));
    expect(html).toMatch(/aria-label="Mute" aria-pressed="true"/);
    expect(html).toContain(">Muted<");
  });

  it("shows Live and the time left out of five minutes, read out as Time left", () => {
    const html = renderToStaticMarkup(createElement(LiveClock, { left: 168, total: 300 }));
    expect(html).toContain("Live");
    expect(html).toContain('role="timer" aria-label="Time left: 2:48"');
    expect(html).toContain("2:48 left");
    expect(html).toContain("width:56%");
  });
});

describe("the end of a call", () => {
  const ended = { conversationId: "oc_" + "a".repeat(32), seconds: 252, heard: { who: "team", run: "shop", stage: "launched", want: "customers" }, learning: false, dropped: false };

  it("thanks them, says how long it was and what Vizzy heard, and links to what it learned", () => {
    const html = render(createElement(VoiceCall, { call: call({ phase: "ended", ended }) }));
    const order = ["Thanks, that's plenty", "4 min 12 s. All four covered.", "What Vizzy heard", "A small team", "Turn sign-ups into customers", "See what I learned", "The transcript is in Settings, under About your business."];
    const at = order.map((w) => html.indexOf(w));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toMatch(new RegExp(`<a href="/admin/welcome/learned\\?c=${ended.conversationId}"[^>]*class="yg-talk `));
    expect(html).not.toContain("aria-busy");
  });

  it("says how many were covered when it is fewer than four, and that a dropped call kept its words", () => {
    const html = render(createElement(VoiceCall, { call: call({ phase: "ended", ended: { ...ended, seconds: 95, heard: { who: "solo" }, dropped: true } }) }));
    expect(html).toContain("1 min 35 s. 1 of 4 covered.");
    expect(html).toContain('role="status"');
    expect(html).toContain(VOICE_WORDS.dropped);
  });

  it("is busy while Vizzy learns from the call", () => {
    const html = render(createElement(VoiceCall, { call: call({ phase: "ended", ended: { ...ended, learning: true } }) }));
    expect(html).toMatch(/aria-busy="true" aria-disabled="true"/);
    expect(html).toContain("animate-spin");
  });
});

describe("the call's words", () => {
  it("keep to house style", () => {
    const words = [
      ...(Object.values(VOICE_WORDS) as unknown[]).filter((v): v is string => typeof v === "string"),
      VOICE_WORDS.left("2:48"),
      VOICE_WORDS.leftAria("2:48"),
      VOICE_WORDS.covered("A small team"),
      VOICE_WORDS.allCovered("4 min 12 s"),
      VOICE_WORDS.someCovered("4 min", 3),
    ];
    for (const w of words) {
      expect(dashesIn(w), w).toEqual([]);
      expect(aiTellsIn(w), w).toEqual([]);
    }
  });
});
