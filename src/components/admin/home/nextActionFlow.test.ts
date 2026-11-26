import { describe, expect, it, vi } from "vitest";
import { arrangeCard } from "@/lib/nextAction/arrange";
import type { CardStepView, CardView } from "@/lib/nextAction/view";
import { NEXT_ACTION_WORDS as W } from "@/lib/nextAction/words";
import { NextActionFlow, answerLine, outcomeVerdict, type Posted } from "./nextActionFlow";

/**
 * What the card does when the founder presses something, with fetch stubbed: the order of the
 * requests, and what the card on the page shows after each answer. Made-up plant shop.
 */

const step = (key: "s1" | "s2" | "s3", more: Partial<CardStepView> = {}): CardStepView => ({
  key,
  n: 0,
  title: `Step ${key}`,
  why: "You said time is tight.",
  state: "open",
  today: false,
  button: null,
  question: null,
  goal: null,
  ...more,
});

const ASK = step("s1", { button: { label: "Draft it with Vizzy", href: null, prompt: "Draft a waitlist page for my idea" } });
const CHIPS = step("s2", { question: { label: "How often?", options: ["Every week", "Every 2 weeks"], picked: null, keeps: true } });

const card = (cardId: string, steps: CardStepView[]): CardView => arrangeCard({ cardId, note: null, steps });

/** A fetch stub whose answers the test releases one at a time, in any order. */
function server() {
  const calls: Array<{ url: string; body: Record<string, unknown>; answer: (p: Posted) => void }> = [];
  const post = vi.fn(
    (url: string, body: unknown) =>
      new Promise<Posted>((resolve) => {
        calls.push({ url, body: body as Record<string, unknown>, answer: resolve });
      }),
  );
  return { post, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Your next action on the page", () => {
  it("ask: the chat gets the prompt at once, and the new card is asked for only after the outcome is saved", async () => {
    const s = server();
    const ask = vi.fn();
    const flow = new NextActionFlow(card("nc_0000000000000001", [ASK]), { post: s.post });
    const pressed = flow.ask("nc_0000000000000001", ASK, ask);
    expect(ask).toHaveBeenCalledWith("Draft a waitlist page for my idea");
    expect(s.calls.map((c) => c.url)).toEqual(["/api/admin/next-action/outcome"]);
    // Until the server has it, the step stays open and no new card is asked for.
    expect(flow.snapshot().view!.steps[0]!.state).toBe("open");
    await flush();
    expect(s.calls).toHaveLength(1);
    s.calls[0]!.answer({ status: 200, body: { ok: true, suggestion: null } });
    await pressed;
    expect(flow.snapshot().view!.steps[0]).toMatchObject({ state: "done", today: true });
    expect(s.calls.map((c) => [c.url, c.body.reason ?? c.body.outcome])).toEqual([
      ["/api/admin/next-action/outcome", "done"],
      ["/api/admin/next-action", "state"],
    ]);
  });

  it("ask: a failed save leaves the step open and says so; a card that changed says so", async () => {
    for (const [answer, message] of [
      [{ status: 500, body: {} }, W.saveFailed],
      [{ status: 409, body: { error: "card_changed" } }, W.cardChanged],
    ] as const) {
      const s = server();
      const flow = new NextActionFlow(card("nc_0000000000000001", [ASK]), { post: s.post });
      const pressed = flow.ask("nc_0000000000000001", ASK, vi.fn());
      s.calls[0]!.answer(answer);
      await pressed;
      expect(flow.snapshot().view!.steps[0]!.state).toBe("open");
      expect(flow.snapshot().message).toBe(message);
      expect(s.calls).toHaveLength(1);
    }
  });

  it("a late answer for a card that was replaced never puts the old card back", async () => {
    const s = server();
    const flow = new NextActionFlow(card("nc_0000000000000001", [ASK, CHIPS]), { post: s.post });
    const answered = flow.answer("nc_0000000000000001", CHIPS, 1);
    const another = flow.compose("another");
    const fresh = card("nc_0000000000000002", [step("s1", { title: "Post about the gift box" })]);
    // The new card comes back first, then the answer to the old one.
    s.calls[1]!.answer({ status: 200, body: { composed: true, view: fresh } });
    await another;
    s.calls[0]!.answer({ status: 200, body: { ok: true, suggestion: "waiting" } });
    expect(await answered).toEqual({ ok: true, line: W.answerWaiting });
    expect(flow.snapshot().view).toEqual(fresh);
    expect(s.calls).toHaveLength(2);
  });

  it("an answer turns its step into a done note with the pick, and says whether it waits in About your business", async () => {
    const s = server();
    const flow = new NextActionFlow(card("nc_0000000000000001", [ASK, CHIPS]), { post: s.post });
    const answered = flow.answer("nc_0000000000000001", CHIPS, 1);
    expect(s.calls[0]!.body).toEqual({ cardId: "nc_0000000000000001", step: "s2", outcome: "answered", choice: 1 });
    s.calls[0]!.answer({ status: 200, body: { ok: true, suggestion: "too_many_waiting" } });
    expect(await answered).toEqual({ ok: true, line: W.answerTooMany });
    const v = flow.snapshot().view!;
    // Done first, then the open steps numbered on from it.
    expect(v.steps.map((x) => [x.key, x.state, x.n])).toEqual([
      ["s2", "answered", 1],
      ["s1", "open", 2],
    ]);
    expect(v.steps[0]!.question!.picked).toBe("Every 2 weeks");
    expect([v.done, v.total]).toEqual([1, 2]);
    expect(flow.snapshot().notice).toBe(W.answerTooMany);
  });

  it("a dismissed step leaves the card once saved; dismissing the last one asks for a new card", async () => {
    const s = server();
    const flow = new NextActionFlow(card("nc_0000000000000001", [ASK, CHIPS]), { post: s.post });
    const first = flow.dismiss("nc_0000000000000001", ASK, "We have a list");
    expect(s.calls[0]!.body).toEqual({ cardId: "nc_0000000000000001", step: "s1", outcome: "dismissed", reason: "We have a list" });
    s.calls[0]!.answer({ status: 200, body: { ok: true, suggestion: null } });
    expect(await first).toBe(true);
    expect(flow.snapshot().view!.steps.map((x) => [x.key, x.n])).toEqual([["s2", 1]]);
    expect(flow.snapshot().live).toBe(W.dismissed);
    expect(s.calls).toHaveLength(1);
    const last = flow.dismiss("nc_0000000000000001", CHIPS, "");
    expect(s.calls[1]!.body).toEqual({ cardId: "nc_0000000000000001", step: "s2", outcome: "dismissed" });
    s.calls[1]!.answer({ status: 200, body: { ok: true, suggestion: null } });
    expect(await last).toBe(true);
    expect(flow.snapshot().view).toBeNull();
    expect(s.calls[2]!.body).toEqual({ reason: "state" });
  });

  it("Show another that can't write a card keeps the card and says so; so does the day's limit", async () => {
    for (const [body, message] of [
      [{ composed: false, failed: "writing", view: null }, W.anotherFailed],
      [{ composed: false, held: "limited", view: null }, W.limited],
    ] as const) {
      const s = server();
      const before = card("nc_0000000000000001", [ASK]);
      const flow = new NextActionFlow(before, { post: s.post });
      const another = flow.compose("another");
      s.calls[0]!.answer({ status: 200, body });
      await another;
      expect(flow.snapshot()).toMatchObject({ view: before, message, writing: false });
    }
  });

  it("looks once more shortly when another tab is writing the card", async () => {
    const s = server();
    const later = vi.fn();
    const flow = new NextActionFlow(null, { post: s.post, later });
    const asked = flow.compose("state");
    s.calls[0]!.answer({ status: 200, body: { composed: false, held: "busy", view: null } });
    await asked;
    expect(later).toHaveBeenCalledWith(expect.any(Function), 6000);
  });
});

describe("the words for what became of a step", () => {
  it("names a saved outcome, a changed card and a failure", () => {
    expect(outcomeVerdict({ status: 200, body: {} })).toBe("applied");
    expect(outcomeVerdict({ status: 409, body: { error: "already_decided" } })).toBe("applied");
    expect(outcomeVerdict({ status: 409, body: { error: "card_changed" } })).toBe("changed");
    expect(outcomeVerdict({ status: 0, body: {} })).toBe("failed");
  });

  it("never says Got it for an answer About your business did not keep waiting", () => {
    expect(answerLine("waiting")).toBe(W.answerWaiting);
    expect(answerLine("already_known")).toBe(W.answerKnown);
    expect(answerLine("too_many_waiting")).toBe(W.answerTooMany);
    expect(answerLine("too_many_facts")).toBe(W.answerFull);
    expect(answerLine("not_saved")).toBe(W.answerNotSaved);
    expect(answerLine("already_decided")).toBe(W.answerNotSaved);
    expect(answerLine(null)).toBe(W.answerGot);
  });
});
