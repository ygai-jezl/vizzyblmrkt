import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { arrangeCard } from "@/lib/nextAction/arrange";
import type { CardView } from "@/lib/nextAction/view";
import { NEXT_ACTION_WORDS } from "@/lib/nextAction/words";

const shell = vi.hoisted(() => ({ value: { ask: vi.fn() } as { ask: (t: string) => void } | null }));
vi.mock("../nav/ShellProvider", () => ({ useShell: () => shell.value }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { NextActionCard } = await import("./NextActionCard");

/** A made-up plant shop's card, as the mockups draw it (After an action is done: 1 of 4 done). */
const VIEW: CardView = arrangeCard({
  cardId: "nc_0000000000000001",
  steps: [
    {
      key: "s1",
      n: 0,
      title: "Turn on the welcome email",
      why: "Market visitors hear from you the same day they sign up.",
      state: "open",
      today: false,
      button: { label: "Open the welcome email", href: "/admin/launches/lch_1/journey", prompt: null },
      question: null,
      goal: null,
    },
    {
      key: "s2",
      n: 0,
      title: "A sign-up card for your market stalls",
      why: "You sell at three farmers' markets. Regulars scan it and join.",
      state: "open",
      today: false,
      button: { label: "Plan it with Vizzy", href: null, prompt: "Plan a sign-up card or QR code for the places I meet customers in person" },
      question: null,
      goal: null,
    },
    {
      key: "s3",
      n: 0,
      title: "Pick a newsletter rhythm",
      why: "You said time is tight, so start small.",
      state: "open",
      today: false,
      button: null,
      question: { label: "How often?", options: ["Every week", "Every 2 weeks", "Once a month"], picked: null, keeps: true },
      goal: null,
    },
  ],
  note: { text: "Your gift box waitlist is live.", today: true },
});

const html = (view: CardView | null, children: ReactNode = null) =>
  renderToStaticMarkup(createElement(NextActionCard, { initial: view, stale: false }, children)).replace(/&#x27;/g, "'");

describe("Home's Your next action card", () => {
  it("draws the steps with their why, the buttons the server resolved, and the footer", () => {
    const out = html(VIEW);
    // The heading takes focus when a saved answer or dismissal takes its row away.
    expect(out).toContain(`<h2 id="next-action-h" tabindex="-1" class="text-sm font-semibold focus:outline-none">${NEXT_ACTION_WORDS.title}</h2>`);
    // The note from the card before counts as one done, and the steps are numbered on from it.
    expect(out).toContain("1 of 4 done");
    expect(out).toMatch(/>2<\/span>.*Turn on the welcome email/);
    for (const s of VIEW.steps) {
      expect(out).toContain(s.title);
      expect(out).toContain(s.why);
    }
    expect(out).toContain('href="/admin/launches/lch_1/journey"');
    expect(out).toContain("Plan it with Vizzy");
    // The prompt is never a link: it goes to the chat.
    expect(out).not.toContain("href=\"Plan a sign-up card");
    expect(out).toContain("Your gift box waitlist is live.");
    expect(out).toContain(NEXT_ACTION_WORDS.doneToday);
    expect(out).toContain(NEXT_ACTION_WORDS.from);
    expect(out).toContain(NEXT_ACTION_WORDS.another);
  });

  it("is reachable and labelled: progress, the question's chips, and Dismiss on each step", () => {
    const out = html(VIEW);
    expect(out).toContain('role="progressbar" aria-label="Steps done" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1"');
    expect(out).toContain('role="group" aria-label="How often?"');
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(3);
    for (const s of VIEW.steps) expect(out).toContain(`aria-label="${NEXT_ACTION_WORDS.dismissLabel(s.title)}"`);
    expect(out.match(/aria-expanded="false"/g)).toHaveLength(3);
    expect(out).toContain('role="status"');
  });

  it("draws done and answered steps as notes first, numbers the open ones on from them, and draws a goal against the brand's count", () => {
    const done = arrangeCard({
      cardId: VIEW.cardId,
      steps: [
        { ...VIEW.steps[0]!, state: "done", today: true },
        { ...VIEW.steps[2]!, state: "answered", today: false, question: { ...VIEW.steps[2]!.question!, picked: "Every 2 weeks" } },
        { key: "s3", n: 0, title: "Your goal: 100 sign-ups", why: "You said a hundred sign-ups means you build it.", state: "open", today: false, button: null, question: null, goal: { now: 12, target: 100 } },
      ],
      note: null,
    });
    const out = html(done);
    expect(out).toContain("2 of 3 done");
    expect(out).toContain(`aria-label="${NEXT_ACTION_WORDS.doneLabel}"`);
    expect(out).toMatch(/Turn on the welcome email<\/span><span[^>]*>Done today/);
    expect(out).toContain("Pick a newsletter rhythm: Every 2 weeks");
    // A done step has no button and no Dismiss any more.
    expect(out).not.toContain('href="/admin/launches/lch_1/journey"');
    expect(out).not.toContain(NEXT_ACTION_WORDS.dismissLabel("Turn on the welcome email"));
    expect(out).toMatch(/>3<\/span>.*Your goal: 100 sign-ups/);
    expect(out).toContain("12 of 100");
    expect(out).toContain('aria-valuemax="100" aria-valuenow="12"');
  });

  it("gives every focus ring the card's colour behind it, so dark mode shows no white halo", () => {
    const out = html(VIEW);
    const rings = out.match(/focus-visible:ring-offset-1/g) ?? [];
    expect(rings.length).toBeGreaterThan(0);
    expect((out.match(/focus-visible:ring-offset-shell-card/g) ?? []).length).toBe(rings.length);
  });

  it("hides a button that asks Vizzy where there is no chat to ask", () => {
    shell.value = null;
    try {
      expect(html(VIEW)).not.toContain("Plan it with Vizzy");
    } finally {
      shell.value = { ask: vi.fn() };
    }
  });

  it("shows the steps list when there is no card", () => {
    const out = html(null, createElement("section", null, "Steps list"));
    expect(out).toContain("<section>Steps list</section>");
    expect(out).not.toContain(NEXT_ACTION_WORDS.another);
  });

  it("keeps house style in every word it shows", () => {
    const words = Object.values(NEXT_ACTION_WORDS).map((w) => (typeof w === "function" ? (w as (...a: unknown[]) => string)(3, 10) : w));
    for (const w of words) expect([...dashesIn(w), ...aiTellsIn(w)], w).toEqual([]);
  });
});
