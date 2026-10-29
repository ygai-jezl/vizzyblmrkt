import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BlogBriefSchema } from "@/lib/types/contentPlan";
import { BlogBriefPanel } from "./BlogBriefPanel";
import type { BlogHubControls } from "./types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/" }));

const QUESTIONS = [
  { id: "bn_q1aaaaaaaa", question: "What did daily checks cost you?", answer: "Daily checks took an hour we never got back." },
  { id: "bn_q2aaaaaaaa", question: "When did a weekly check miss a change?", answer: "", also: ["Tracking AI referral traffic"] },
];
const brief = (seen: Record<string, unknown>) =>
  BlogBriefSchema.parse({ primaryQuestion: "How often should you check?", seen: { matchedAt: "2026-10-20T10:00:00.000Z", ...seen } });
const controls = (b: ReturnType<typeof brief>, over: Partial<BlogHubControls> = {}): BlogHubControls => ({
  brief: b,
  onBriefChange: vi.fn(),
  onResearch: vi.fn(),
  onCheckFacts: vi.fn(),
  busy: null,
  note: null,
  noteFor: "research",
  pageUrl: null,
  brandName: "Acme",
  logoUrl: null,
  onFindSeen: vi.fn(),
  ...over,
});
const html = (c: BlogHubControls) => renderToStaticMarkup(createElement(BlogBriefPanel, { controls: c }));
const answers = { save: vi.fn(), done: vi.fn(), state: {} };

describe("What we've seen in the article's brief", () => {
  it("gives each question its own card, says they are kept, and leaves out the shared box", () => {
    const out = html(controls(brief({ asks: QUESTIONS.map((q) => q.question), questions: QUESTIONS }), { answers }));
    expect(out).toContain("Answer any of these and the article can speak from experience");
    expect(out).toContain("Each question is kept on What we’ve seen, linked to this article, answered or not.");
    expect(out).toContain("What did daily checks cost you?");
    expect(out).toContain("Also asked for: Tracking AI referral traffic");
    expect(out).toContain(">Answered<");
    expect(out).not.toContain("Also save to your brand");
    // One is answered: the article speaks from it, so the box no longer says nothing matched.
    expect(out).toContain(">1 answered<");
    expect(out).toContain("so the article speaks from your team’s answers");
    expect(out).not.toContain("claims no experience of its own");
  });

  it("keeps the shared box for an article from before that has text in it", () => {
    const out = html(controls(brief({ questions: QUESTIONS, own: "Something we saw." }), { answers }));
    expect(out).toContain("Also save to your brand");
  });

  it("is the shared box as before with the switch off", () => {
    const out = html(controls(brief({ asks: QUESTIONS.map((q) => q.question), questions: QUESTIONS })));
    expect(out).toContain("Answer one of these and the article can speak from experience");
    expect(out).toContain("Also save to your brand");
    expect(out).not.toContain("Each question is kept on What we");
  });

  describe("with notes resting after use", () => {
    const NOTE = { id: "bn_n1aaaaaaaa", text: "A brand dropped out of answers for two weeks.", why: "Linked to this article's subject", usedIn: 1, lastUsedAt: "2026-09-18T10:00:00.000Z" };
    const FIRST = { ...NOTE, id: "bn_n2aaaaaaaa", text: "Teams that track every prompt act on a handful.", usedIn: 0, lastUsedAt: null };
    const RESTING = [
      { id: "bn_r1aaaaaaaa", text: "A rival's page went offline.", reason: "recent", byTitle: "Prompt tracking for agencies", byAt: "2026-10-23T09:00:00.000Z", until: "2026-11-22T09:00:00.000Z", usedIn: 1 },
      { id: "bn_r2aaaaaaaa", text: "Daily swings were mostly noise.", reason: "used_up", usedIn: 3 },
      { id: "bn_r3aaaaaaaa", text: "Local shops say AI answers don't matter.", reason: "held", byTitle: "Share of voice for local shops" },
    ];
    const OPEN = QUESTIONS.map((q) => ({ ...q, answer: "" }));

    it("says how often each note was used, lists the resting ones with why, and asks new questions anyway", () => {
      const out = html(controls(brief({ matchedAt: "2026-10-29T10:00:00.000Z", notes: [NOTE, FIRST], resting: RESTING, questions: OPEN }), { answers, seenRest: true }));
      expect(out).toContain(">2 from your brand · 2 to answer<");
      expect(out).toContain("Used in 1 article before · last on 18 Sept");
      expect(out).toContain("First time in an article");
      expect(out).toContain("3 fit this question but are resting · Hide");
      expect(out).toContain("Used in “Prompt tracking for agencies” on 23 Oct · rests until 22 Nov");
      expect(out).toContain("Used in 3 articles · goes in only when you add it");
      expect(out).toContain("In the draft “Share of voice for local shops”, not written yet");
      expect(out.match(/Use anyway/g)).toHaveLength(3);
      expect(out).toContain("New for this article");
      expect(out).toContain("Answer any of these and the article says something none of your others do.");
    });

    it("says so when every note that fits is resting", () => {
      const out = html(controls(brief({ resting: RESTING.slice(0, 1), questions: OPEN }), { answers, seenRest: true }));
      expect(out).toContain("The notes that fit this question were used recently, so they rest.");
      expect(out).toContain(">2 to answer<");
    });

    it("shows none of it with the switch off", () => {
      const out = html(controls(brief({ notes: [NOTE], resting: RESTING, questions: OPEN }), { answers }));
      expect(out).not.toContain("resting");
      expect(out).not.toContain("Used in 1 article");
      expect(out).not.toContain("New for this article");
      expect(out).toContain(">1 from your brand<");
    });
  });
});
