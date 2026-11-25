import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProfileAnswers, ProfileKey } from "@/lib/types/businessProfile";
import type { ConversationSource, LearnedAnswer, LearnedFact } from "@/lib/types/onboarding";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { OnboardingFrame } = await import("./OnboardingFrame");
const { LearnedReview } = await import("./LearnedReview");
const { BasicsGrid, FactList, TranscriptBody, deleteConversationText } = await import("./parts");

// A made-up plant shop, as the owner-approved mockups draw it (o-canvas Learned.html).
const ANSWERS: Record<ProfileKey, LearnedAnswer> = {
  who: { value: null, words: "It's mostly me. My sister helps at the markets." },
  run: { value: "shop", words: "We run a little plant shop" },
  stage: { value: "established", words: "Six years now." },
  want: { value: "audience", words: "more people knowing us" },
};
const FACTS: LearnedFact[] = [
  { id: "f0", kind: "timeline", text: "Launch before the Christmas markets", quote: "We want a Christmas gift box out before the Christmas markets start." },
  { id: "f1", kind: "channel", text: "Sells at three farmers' markets", quote: "We sell at three farmers' markets most weekends." },
  { id: "f2", kind: "start", text: "No email list yet", quote: "We've never had an email list. It's all been word of mouth." },
  { id: "f3", kind: "constraint", text: "Worried about the time it takes", quote: "Honestly, I'm worried about the time it takes." },
  { id: "f4", kind: "goal", text: "A Christmas gift box", quote: "A plant, a pot and a care card." },
];
const CONV: { id: string; source: ConversationSource; startedAt: string; lengthSec: number; turnCount: number } = { id: `oc_${"a".repeat(32)}`, source: "voice", startedAt: `${new Date().getUTCFullYear()}-11-25T10:00:00.000Z`, lengthSec: 252, turnCount: 9 };

const plain = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const inFrame = (child: ReactNode, saved: ProfileAnswers = {}) =>
  plain(renderToStaticMarkup(createElement(OnboardingFrame, { brand: { name: "Fernhill Plants", faviconUrl: "" }, voice: true, answers: saved }, child)));
const learned = (over: Partial<{ answers: Record<ProfileKey, LearnedAnswer>; facts: LearnedFact[] }> = {}, conv = CONV, saved: ProfileAnswers = {}) =>
  inFrame(createElement(LearnedReview, { conversation: conv, learned: { answers: ANSWERS, facts: FACTS, ...over } }), saved);

describe("Here's what I learned", () => {
  it("says where it came from, then the heading, the lead, the basics and what else it heard, in the mockup's order", () => {
    const html = learned();
    const order = ["From our call, 4 min, 25 Nov", "Here's what I learned", "Change anything that's off. Vizzy reads this in every chat.", "The basics", "What else I heard", "Looks right", "Read the transcript"];
    const at = order.map((w) => html.indexOf(w));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toMatch(/What else I heard <span[^>]*>5<\/span>/);
  });

  it("shows each answer as a chip that opens its choices", () => {
    const html = learned();
    expect(html).toContain('aria-label="What you run: A shop or products. Change"');
    expect(html).toContain('aria-label="Where it is today: Established, ready to grow. Change"');
    expect(html).toMatch(/aria-haspopup="menu"/);
  });

  it("asks about a blank with the member's unclear words and the three choices", () => {
    const html = learned();
    expect(html).toContain("Not sure yet");
    expect(html).toContain("I couldn't tell from “It's mostly me. My sister helps at the markets.” Which fits?");
    expect(html).toMatch(/role="group" aria-label="Who you are"/);
    for (const label of ["A solo founder", "A small team", "An agency, for clients"]) expect(html).toContain(label);
  });

  it("leaves out the unclear line when there are no words, and fills a blank from the brand's saved answer", () => {
    const html = learned({ answers: { ...ANSWERS, who: { value: null, words: "" } } });
    expect(html).toContain("Not sure yet");
    expect(html).not.toContain("I couldn't tell");
    const filled = learned({}, CONV, { who: "agency" });
    expect(filled).not.toContain("Not sure yet");
    expect(filled).toContain('aria-label="Who you are: An agency, for clients. Change"');
  });

  it("lists each fact with its kind, the member's own words and Remove", () => {
    const html = learned();
    for (const kind of ["Timeline", "Channel", "Starting point", "Constraint", "Goal"]) expect(html).toContain(`>${kind}</span>`);
    expect(html).toContain("<q");
    expect(html).toContain("We sell at three farmers' markets most weekends.");
    expect(html).toContain('aria-label="Remove No email list yet"');
    expect(html.split(">Remove<").length - 1).toBe(5);
  });

  it("says Nothing else for now with no facts", () => {
    const html = learned({ facts: [] });
    expect(html).toContain("Nothing else for now.");
    expect(html).toMatch(/What else I heard <span[^>]*>0<\/span>/);
  });

  it("names a chat as a chat", () => {
    const html = learned({}, { ...CONV, source: "chat", turnCount: 11 });
    expect(html).toContain("From our chat, 11 messages, 25 Nov");
    expect(html).toContain("Read the chat");
  });

  it("keeps the transcript out of the page until it is opened", () => {
    expect(learned()).not.toContain("Read the conversation");
  });
});

describe("the shared parts", () => {
  it("Settings asks for an unanswered question with a Not picked chip that opens the menu", () => {
    const html = plain(renderToStaticMarkup(createElement(BasicsGrid, { answers: { run: "service" }, blank: "notPicked", onPick: () => undefined })));
    expect(html).toContain('aria-label="Who you are: not picked. Change"');
    expect(html).toContain(">Not picked<");
    expect(html).not.toContain("Not sure yet");
    expect(html).toContain('aria-label="What you run: A service or local business. Change"');
  });

  it("Settings' fact list puts the words and where they came from on one line", () => {
    const html = plain(renderToStaticMarkup(createElement(FactList, { facts: [{ ...FACTS[2]!, src: "From a chat, 25 Nov" }], onRemove: () => undefined, compact: true })));
    expect(html).toMatch(/<q[^>]*>We've never had an email list\. It's all been word of mouth\.<\/q>.*From a chat, 25 Nov/);
  });

  it("the transcript shows who said what, loading and failing in its own words", () => {
    const c = { id: CONV.id, source: "voice" as const, startedAt: CONV.startedAt, lengthSec: 252 };
    const ok = plain(
      renderToStaticMarkup(
        createElement(TranscriptBody, {
          c,
          loaded: { id: c.id, status: "ok", turns: [{ who: "vizzy", text: "Hi! Who's behind it?" }, { who: "member", text: "It's me and two others." }] },
          onRetry: () => undefined,
        }),
      ),
    );
    expect(ok).toContain("Call with Vizzy");
    expect(ok).toContain("25 Nov, 4 min 12 s, 2 turns");
    expect(ok).toMatch(/>Vizzy<\/span><span[^>]*>Hi! Who's behind it\?/);
    expect(ok).toMatch(/>You<\/span><span[^>]*>It's me and two others\./);
    expect(ok).toContain("Only your admins and Vizzy can read this. No audio is kept.");
    const loading = plain(renderToStaticMarkup(createElement(TranscriptBody, { c, loaded: null, onRetry: () => undefined })));
    expect(loading).toContain("Getting the words.");
    expect(loading).toContain("25 Nov, 4 min 12 s");
    const failed = plain(renderToStaticMarkup(createElement(TranscriptBody, { c, loaded: { id: c.id, status: "failed" }, onRetry: () => undefined })));
    expect(failed).toContain("The transcript didn't load.");
    expect(failed).toContain("Try again");
  });

  it("the delete dialog names the call and its date", () => {
    expect(deleteConversationText({ source: "voice", startedAt: CONV.startedAt })).toBe("The transcript of your call on 25 Nov goes for good.");
    expect(deleteConversationText({ source: "chat", startedAt: CONV.startedAt })).toBe("The transcript of your chat on 25 Nov goes for good.");
  });
});
