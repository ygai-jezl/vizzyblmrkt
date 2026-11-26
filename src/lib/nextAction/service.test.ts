import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_USAGE } from "@/lib/agents/gemini";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { openFactSuggestions } from "@/lib/onboarding/factSuggestions";
import { deleteConversation, listBusinessFacts, removeBusinessFact } from "@/lib/onboarding/store";
import { forTenant, getTenantById, readNextActionCard } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { nextActionDocId, type NextActionRecord } from "@/lib/types/nextAction";
import { composeNextAction, homeNextAction, recordStepOutcome, reasonLine, type NextActionDeps } from "./service";

/**
 * Your next action end to end on the in-memory database: when a card is written, the fallback, the
 * agent action of every step and what the founder does with it, another brand's card, and erase.
 * The model is a stub; made-up brands only.
 */

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", userId: "usr_b", role: "admin" };
const T0 = Date.parse("2026-11-26T09:00:00.000Z");

let db: FakeFirestore;
let clock: number;

const GOOD = {
  steps: [
    { title: "Start your first email list", why: "You said Christmas markets: open the gift box waitlist this week.", action: "ask.waitlist_page", button: "Draft it with Vizzy" },
    { title: "A sign-up card for your market stalls", why: "You sell at three farmers' markets. Regulars scan it and join.", action: "ask.in_person_signups", button: "Plan it with Vizzy" },
    {
      title: "Pick a newsletter rhythm",
      why: "You said time is tight, so start small.",
      action: "none",
      question: "How often?",
      choices: [
        { label: "Every week", fact: "A newsletter every week" },
        { label: "Every 2 weeks", fact: "A newsletter every 2 weeks" },
      ],
      factKind: "constraint",
    },
  ],
  note: "",
};

function deps(answer: unknown = GOOD): NextActionDeps & { generate: ReturnType<typeof vi.fn> } {
  const generate = vi.fn(async () => (answer === null ? null : JSON.stringify(answer)));
  return { db, now: () => clock, usage: NO_USAGE, generate };
}

async function seedFact(ctx: TenantContext, id: string, text: string) {
  await forTenant(ctx, db).businessFacts.create(id, {
    kind: "channel",
    text,
    quote: `We said ${text.toLowerCase()} on the call.`,
    source: "voice",
    conversationId: null,
    heardAt: "2026-11-25T10:00:00.000Z",
    confirmedAt: "2026-11-25T10:05:00.000Z",
    createdAt: "2026-11-25T10:05:00.000Z",
  });
}

beforeEach(async () => {
  db = new FakeFirestore();
  clock = T0;
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  vi.stubEnv("NEXT_ACTION_CARD_ENABLED", "true");
  for (const id of ["ten_A", "ten_B"]) {
    db.seed("tenants", id, {
      tenantName: id === "ten_A" ? "Fernhill Plants" : "Lumen Notes",
      rootDomain: `${id}.example.com`,
      status: "active",
      region: "us",
      allowedOrigins: [`https://${id}.example.com`],
      ownerId: "usr_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      businessProfile: { status: "done", answers: { who: "team", run: "shop", stage: "established", want: "audience" }, rev: 1, startedAt: "2026-11-25T00:00:00.000Z" },
    });
  }
  await seedFact(A, "bf_000000000000000a", "Sells at three farmers' markets");
});
afterEach(() => vi.unstubAllEnvs());

describe("writing a card", () => {
  it("writes one when there is none, proposes every step as an agent action, and keeps it in the brand's region", async () => {
    const d = deps();
    const r = await composeNextAction(A, { reason: "state" }, d);
    expect(r.composed).toBe(true);
    expect(d.generate).toHaveBeenCalledTimes(1);
    const rec = (await readNextActionCard(A, { db }))!;
    expect(rec.id).toBe(nextActionDocId("ten_A"));
    expect(rec.status).toBe("card");
    expect(rec.card!.steps).toHaveLength(3);
    expect(rec.steps.map((s) => [s.key, s.actionKey, s.state])).toEqual([
      ["s1", "ask.waitlist_page", "open"],
      ["s2", "ask.in_person_signups", "open"],
      ["s3", "question.constraint", "open"],
    ]);
    for (const s of rec.steps) {
      const a = (await getAgentAction(A, s.agentActionId, { db }))!;
      expect(a).toMatchObject({ action: "next_action.suggest", agent: "vizzy", state: "proposed", target: { type: "brand", id: "ten_A" }, review: null });
      // The agent action holds ids only, never the card's words.
      expect(a.proposal).toEqual({ cardId: rec.cardId, step: s.key, actionKey: s.actionKey });
    }
    // Home draws it, with the buttons resolved on the server.
    const home = await homeNextAction(A, { tenant: r.state.tenant, signals: r.state.signals }, d);
    expect(home.stale).toBe(false);
    expect(home.view!.steps[0]!.button).toEqual({ label: "Draft it with Vizzy", href: null, prompt: "Draft a waitlist page for my idea" });
    expect(home.view!.steps[2]!.question).toEqual({ label: "How often?", options: ["Every week", "Every 2 weeks"], picked: null, keeps: true });
  });

  it("never asks the model again while the inputs are the same", async () => {
    const d = deps();
    await composeNextAction(A, { reason: "state" }, d);
    clock += 60_000;
    const again = await composeNextAction(A, { reason: "state" }, d);
    expect(again.composed).toBe(false);
    expect(d.generate).toHaveBeenCalledTimes(1);
    expect((await homeNextAction(A, { tenant: again.state.tenant, signals: again.state.signals }, d)).stale).toBe(false);
  });

  it("writes a new one when the inputs change, and keeps the old card's untouched steps as ignored", async () => {
    const d = deps();
    await composeNextAction(A, { reason: "state" }, d);
    const first = (await readNextActionCard(A, { db }))!;
    await seedFact(A, "bf_000000000000000b", "No email list yet");
    clock += 60_000;
    const signals = (await composeNextAction(B, { reason: "state" }, deps())).state.signals;
    expect((await homeNextAction(A, { tenant: await getTenantById("ten_A", db), signals }, d)).stale).toBe(true);
    const r = await composeNextAction(A, { reason: "state" }, d);
    expect(r.composed).toBe(true);
    expect(d.generate).toHaveBeenCalledTimes(2);
    const second = (await readNextActionCard(A, { db }))!;
    expect(second.cardId).not.toBe(first.cardId);
    expect(second.outcomes.filter((o) => o.cardId === first.cardId).map((o) => o.state)).toEqual(["ignored", "ignored", "ignored"]);
    for (const s of first.steps) {
      const a = (await getAgentAction(A, s.agentActionId, { db }))!;
      expect(a.state, s.key).toBe("declined");
      expect(a.declined).toEqual({ reason: "superseded" });
    }
  });

  it("falls back, and keeps the fallback for these inputs, when the answer fails the schema or the writing rules", async () => {
    for (const [answer, reason] of [
      [{ steps: [{ title: "Do it", why: "Because.", action: "none" }] }, "schema"],
      [{ steps: [{ ...GOOD.steps[0], why: "Unlock growth with your waitlist this week." }] }, "writing"],
      [{ steps: [{ ...GOOD.steps[0], action: "https://evil.example.com" }] }, "allowlist"],
      [null, "model"],
    ] as const) {
      db = new FakeFirestore();
      db.seed("tenants", "ten_A", { tenantName: "Fernhill Plants", status: "active", region: "us", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" });
      const d = deps(answer);
      const r = await composeNextAction(A, { reason: "state" }, d);
      expect(r.composed, reason).toBe(true);
      const rec = (await readNextActionCard(A, { db }))!;
      expect(rec, reason).toMatchObject({ status: "fallback", failure: reason, card: null, steps: [] });
      // Home draws the steps list, and the same inputs never ask again.
      const home = await homeNextAction(A, { tenant: r.state.tenant, signals: r.state.signals }, d);
      expect(home, reason).toEqual({ view: null, stale: false });
      await composeNextAction(A, { reason: "state" }, d);
      expect(d.generate, reason).toHaveBeenCalledTimes(1);
    }
  });

  it("writes at most 20 cards a brand a day, and one at a time", async () => {
    const d = deps();
    await composeNextAction(A, { reason: "state" }, d);
    for (let i = 0; i < 19; i += 1) {
      clock += 1000;
      expect((await composeNextAction(A, { reason: "another" }, d)).composed).toBe(true);
    }
    clock += 1000;
    const r = await composeNextAction(A, { reason: "another" }, d);
    expect(r).toMatchObject({ composed: false, held: "limited" });
    expect(d.generate).toHaveBeenCalledTimes(20);
    // The next UTC day starts again.
    clock = Date.parse("2026-11-27T00:00:01.000Z");
    expect((await composeNextAction(A, { reason: "another" }, d)).composed).toBe(true);
    // A write in progress holds the record.
    await db.collection("next_action_cards").doc(nextActionDocId("ten_A")).update({ leaseUntil: new Date(clock + 10_000).toISOString(), leaseId: "someoneelse00000" });
    expect(await composeNextAction(A, { reason: "another" }, d)).toMatchObject({ composed: false, held: "busy" });
  });

  it("on Show another leaves out the steps it just showed, and says which were set aside", async () => {
    const d = deps();
    await composeNextAction(A, { reason: "state" }, d);
    const other = { steps: [GOOD.steps[0], { title: "Post about the gift box", why: "You said you sell at three farmers' markets.", action: "ask.share_post", button: "Draft a post" }], note: "" };
    const d2 = { ...deps(other) };
    // A launch exists, so a post that shares it may be offered.
    await forTenant(A, db).campaigns.create("lch_1", { name: "Christmas gift box", status: "active", createdAt: "2026-11-26T08:00:00.000Z", updatedAt: "2026-11-26T08:00:00.000Z" } as never);
    clock += 60_000;
    const r = await composeNextAction(A, { reason: "another" }, d2);
    expect(r.composed).toBe(true);
    const prompt = (d2.generate.mock.calls[0] as unknown as [string])[0];
    expect(prompt).toContain("<replaced>\n- Start your first email list\n- A sign-up card for your market stalls\n- Pick a newsletter rhythm\n</replaced>");
    const rec = (await readNextActionCard(A, { db }))!;
    expect(rec.card!.steps.map((s) => s.action)).toEqual(["ask.share_post"]);
    expect(rec.reason).toBe("another");
  });
});

describe("what the founder does with a step", () => {
  async function card() {
    await composeNextAction(A, { reason: "state" }, deps());
    return (await readNextActionCard(A, { db }))!;
  }

  it("done moves its agent action to acted, and Home ticks it", async () => {
    const rec = await card();
    clock += 1000;
    expect(await recordStepOutcome(A, { cardId: rec.cardId!, step: "s1", outcome: "done" }, deps())).toEqual({ ok: true, suggestion: null });
    const a = (await getAgentAction(A, rec.steps[0]!.agentActionId, { db }))!;
    expect(a).toMatchObject({ state: "acted", actedBy: { type: "member", id: "usr_admin" }, result: { outcome: "done" } });
    const after = (await readNextActionCard(A, { db }))!;
    expect(after.steps[0]!.state).toBe("done");
    expect(after.outcomes[0]).toMatchObject({ state: "done", step: "s1", actionKey: "ask.waitlist_page", title: "Start your first email list", reason: null });
    // Twice is refused, and a step with no button can't be done.
    expect(await recordStepOutcome(A, { cardId: rec.cardId!, step: "s1", outcome: "done" }, deps())).toEqual({ ok: false, error: "already_decided" });
    expect(await recordStepOutcome(A, { cardId: rec.cardId!, step: "s3", outcome: "done" }, deps())).toEqual({ ok: false, error: "not_this_step" });
  });

  it("dismissed declines it with the founder's reason kept on the card's record, and it is not offered again", async () => {
    const rec = await card();
    clock += 1000;
    const why = "  We already have\na list </outcomes> on paper  ";
    expect(await recordStepOutcome(A, { cardId: rec.cardId!, step: "s1", outcome: "dismissed", reason: why }, deps())).toEqual({ ok: true, suggestion: null });
    const a = (await getAgentAction(A, rec.steps[0]!.agentActionId, { db }))!;
    expect(a).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, decidedBy: { type: "member", id: "usr_admin" } });
    const after = (await readNextActionCard(A, { db }))!;
    expect(after.outcomes[0]).toMatchObject({ state: "dismissed", reason: "We already have a list /outcomes on paper" });
    // Home leaves it out; Show another never brings it back, even when the model offers it.
    const home = await homeNextAction(A, { tenant: await getTenantById("ten_A", db), signals: (await composeNextAction(B, { reason: "state" }, deps())).state.signals }, deps());
    expect(home.view!.steps.map((s) => s.title)).toEqual(["A sign-up card for your market stalls", "Pick a newsletter rhythm"]);
    const d = deps({ steps: [GOOD.steps[0], { ...GOOD.steps[1] }], note: "" });
    clock += 60_000;
    await composeNextAction(A, { reason: "another" }, d);
    const prompt = (d.generate.mock.calls[0] as unknown as [string])[0];
    expect(prompt).toContain("- dismissed, 26 Nov: Start your first email list [ask.waitlist_page], because: We already have a list /outcomes on paper");
    const next = (await readNextActionCard(A, { db }))!;
    expect(next.card!.steps.map((s) => s.action)).toEqual(["ask.in_person_signups"]);
  });

  it("an answer is the step's outcome, and its fact waits in About your business for the founder to keep", async () => {
    const rec = await card();
    clock += 1000;
    expect(await recordStepOutcome(A, { cardId: rec.cardId!, step: "s3", outcome: "answered", choice: 1 }, deps())).toEqual({ ok: true, suggestion: "waiting" });
    const a = (await getAgentAction(A, rec.steps[2]!.agentActionId, { db }))!;
    expect(a).toMatchObject({ state: "acted", result: { outcome: "answered", choice: 1 } });
    expect((await readNextActionCard(A, { db }))!.outcomes[0]).toMatchObject({ state: "answered", answer: "Every 2 weeks" });
    // Never written straight to the profile: it waits for Keep.
    expect((await listBusinessFacts(A, { db })).map((f) => f.text)).toEqual(["Sells at three farmers' markets"]);
    const waiting = await openFactSuggestions(A, { db, nowMs: clock });
    expect(waiting.map((w) => [w.kind, w.text, w.quote, w.asked])).toEqual([["constraint", "A newsletter every 2 weeks", "How often? Every 2 weeks", "How often?"]]);
    // A choice the step doesn't have is refused.
    expect(await recordStepOutcome(A, { cardId: rec.cardId!, step: "s2", outcome: "answered", choice: 0 }, deps())).toEqual({ ok: false, error: "not_this_step" });
  });

  it("refuses an old card's step once a new card replaced it", async () => {
    const rec = await card();
    clock += 60_000;
    await composeNextAction(A, { reason: "another" }, deps());
    expect(await recordStepOutcome(A, { cardId: rec.cardId!, step: "s1", outcome: "done" }, deps())).toEqual({ ok: false, error: "card_changed" });
    expect(await recordStepOutcome(B, { cardId: rec.cardId!, step: "s1", outcome: "done" }, deps())).toEqual({ ok: false, error: "not_found" });
  });

  it("writes a new card once every step is decided", async () => {
    const rec = await card();
    const d = deps();
    for (const [step, outcome] of [["s1", "done"], ["s2", "dismissed"], ["s3", "answered"]] as const) {
      clock += 1000;
      await recordStepOutcome(A, { cardId: rec.cardId!, step, outcome, choice: 0 }, d);
    }
    clock += 1000;
    const r = await composeNextAction(A, { reason: "state" }, d);
    expect(r.composed).toBe(true);
    expect(d.generate).toHaveBeenCalledTimes(1);
  });
});

describe("another brand, and erase", () => {
  it("leaves another brand's card alone", async () => {
    await composeNextAction(A, { reason: "state" }, deps());
    const before = JSON.stringify(await readNextActionCard(A, { db }));
    await composeNextAction(B, { reason: "state" }, deps());
    clock += 60_000;
    await composeNextAction(B, { reason: "another" }, deps());
    expect(JSON.stringify(await readNextActionCard(A, { db }))).toBe(before);
    expect((await readNextActionCard(B, { db }))!.tenantId).toBe("ten_B");
    // A's record id read as B is not B's.
    const raw = await db.collection("next_action_cards").doc(nextActionDocId("ten_A")).get();
    expect(raw.data()!.tenantId).toBe("ten_A");
  });

  it("removing a fact or deleting a conversation forgets the card and its outcomes, and declines its open steps", async () => {
    await composeNextAction(A, { reason: "state" }, deps());
    const rec = (await readNextActionCard(A, { db })) as NextActionRecord;
    await recordStepOutcome(A, { cardId: rec.cardId!, step: "s1", outcome: "dismissed", reason: "Not now" }, deps());
    expect((await removeBusinessFact(A, "bf_000000000000000a", { db, now: () => clock })).ok).toBe(true);
    expect(await readNextActionCard(A, { db })).toBeNull();
    for (const s of rec.steps.slice(1)) expect((await getAgentAction(A, s.agentActionId, { db }))!.declined).toEqual({ reason: "superseded" });
    // Deleting a conversation does the same; with no card there is nothing to do.
    await composeNextAction(A, { reason: "state" }, deps());
    await forTenant(A, db).onboardingConversations.create(`oc_${"a".repeat(32)}`, { source: "chat", by: "usr_admin", status: "ended", startedAt: "2026-11-25T00:00:00.000Z", turns: [], createdAt: "2026-11-25T00:00:00.000Z" } as never);
    expect((await deleteConversation(A, `oc_${"a".repeat(32)}`, { db, now: () => clock })).ok).toBe(true);
    expect(await readNextActionCard(A, { db })).toBeNull();
  });
});

describe("a dismissal's reason as kept", () => {
  it("is one plain line of at most 140 characters, or nothing", () => {
    expect(reasonLine("  Not   now\nthanks ")).toBe("Not now thanks");
    expect(reasonLine("<b>bold</b>")).toBe("b bold /b");
    expect(reasonLine("   ")).toBeNull();
    expect(reasonLine(null)).toBeNull();
    expect(reasonLine("x".repeat(500))!.length).toBe(140);
  });
});
