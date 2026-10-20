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
});
