import { beforeEach, describe, expect, it } from "vitest";
import { TenantIsolationError } from "./errors";
import { proposeAgentAction } from "./agentActions";
import {
  claimNextActionWrite,
  commitNextActionWrite,
  forgetNextActionCard,
  quietOnly,
  readNextActionCard,
  recordNextActionOutcome,
  releaseNextActionWrite,
  trimOutcomes,
  type NextActionWrite,
} from "./nextActionCards";
import { FakeFirestore } from "./testing/fakeFirestore";
import { timestampFirestore } from "./testing/timestampFirestore";
import type { TenantContext } from "./types";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { agentDedupeKey } from "@/lib/types/agentAction";
import { nextActionDocId, type ActionCard, type CardStepRecord, type Outcome } from "@/lib/types/nextAction";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", userId: "usr_b", role: "admin" };
const T0 = Date.parse("2026-11-26T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const CARD: ActionCard = {
  type: "ActionCard",
  v: 1,
  steps: [{ type: "Step", key: "s1", title: "Create your first idea", why: "You said you want to test it first.", action: "page.create_launch", button: "Create it", choices: null, progress: null }],
  note: null,
};

let db: FakeFirestore;
beforeEach(() => {
  db = timestampFirestore(new FakeFirestore());
});

function outcome(daysAgo: number, i = 0, more: Partial<Outcome> = {}): Outcome {
  return { at: iso(T0 - daysAgo * 86_400_000 - i), cardId: "nc_0000000000000001", step: "s1", actionKey: "page.create_launch", title: `t${i}`, state: "ignored", reason: null, answer: null, ...more };
}

/** A fallback write for the day's count. */
const fallback = (leaseId: string, atMs: number): NextActionWrite => ({
  leaseId,
  at: iso(atMs),
  by: { type: "system", id: "next_action" },
  status: "fallback",
  inputHash: "h",
  cardId: null,
  card: null,
  steps: [],
  failure: "model",
  reason: "state",
  model: "m",
  promptVersion: 1,
});

/** Propose a step's agent action, as the service does. */
async function propose(cardId: string, key: "s1" | "s2", actionKey: string, atMs: number): Promise<CardStepRecord> {
  const saved = await proposeAgentAction(
    A,
    {
      dedupeKey: agentDedupeKey("next_action.suggest", cardId, key),
      agent: "vizzy",
      action: "next_action.suggest",
      target: { type: "brand", id: "ten_A" },
      personId: null,
      proposal: { cardId, step: key, actionKey },
      basis: null,
      signals: [],
      review: null,
      requestedBy: { type: "system", id: "next_action" },
      expiresAt: iso(atMs + 30 * 86_400_000),
      at: iso(atMs),
    },
    { db },
  );
  return { key, actionKey, agentActionId: saved.action.id, state: "open" };
}

describe("next_action_cards, the store", () => {
  it("holds the record for one write, makes it when there is none, and refuses a second write meanwhile", async () => {
    const c = await claimNextActionWrite(A, { nowMs: T0, leaseMs: 45_000, db });
    expect(c.ok).toBe(true);
    expect(await claimNextActionWrite(A, { nowMs: T0 + 1000, leaseMs: 45_000, db })).toMatchObject({ ok: false, reason: "busy" });
    // Past the lease, another write may take it.
    expect((await claimNextActionWrite(A, { nowMs: T0 + 46_000, leaseMs: 45_000, db })).ok).toBe(true);
    const rec = (await readNextActionCard(A, { db }))!;
    expect(rec).toMatchObject({ id: nextActionDocId("ten_A"), tenantId: "ten_A", status: "fallback", card: null, composeCount: 0 });
  });

  it("puts a card in only for the write that holds it, counts it for the day, and lets go", async () => {
    const c = await claimNextActionWrite(A, { nowMs: T0, leaseMs: 45_000, db });
    if (!c.ok) throw new Error("claim");
    const write = {
      at: iso(T0 + 2000),
      by: { type: "system" as const, id: "next_action" },
      status: "card" as const,
      inputHash: "h1",
      cardId: "nc_0000000000000001",
      card: CARD,
      steps: [{ key: "s1" as const, actionKey: "page.create_launch", agentActionId: `aa_${"1".repeat(40)}` as const, state: "open" as const }],
      failure: null,
      reason: "state" as const,
      model: "gemini-test",
      promptVersion: 1,
    };
    expect(await commitNextActionWrite(A, { ...write, leaseId: "notmine000000000" }, { db })).toEqual({ ok: false, reason: "lost" });
    const r = await commitNextActionWrite(A, { ...write, leaseId: c.leaseId }, { db });
    expect(r.ok).toBe(true);
    const rec = (await readNextActionCard(A, { db }))!;
    expect(rec).toMatchObject({ status: "card", inputHash: "h1", cardId: "nc_0000000000000001", composeCount: 1, leaseUntil: null, leaseId: null });
    expect(rec.card).toEqual(CARD);
    // A released hold frees the record at once.
    const again = await claimNextActionWrite(A, { nowMs: T0 + 3000, leaseMs: 45_000, db });
    if (!again.ok) throw new Error("claim");
    await releaseNextActionWrite(A, again.leaseId, { db });
    expect((await claimNextActionWrite(A, { nowMs: T0 + 4000, leaseMs: 45_000, db })).ok).toBe(true);
  });

  it("refuses the brand's cards past its day's cap", async () => {
    for (let i = 0; i < 2; i += 1) {
      const c = await claimNextActionWrite(A, { nowMs: T0 + i * 60_000, leaseMs: 1000, maxPerDay: 2, db });
      if (!c.ok) throw new Error("claim");
      await commitNextActionWrite(A, { leaseId: c.leaseId, at: iso(T0 + i * 60_000 + 10), by: { type: "system", id: "next_action" }, status: "fallback", inputHash: "h", cardId: null, card: null, steps: [], failure: "model", reason: "state", model: "m", promptVersion: 1 }, { db });
    }
    expect(await claimNextActionWrite(A, { nowMs: T0 + 3 * 60_000, leaseMs: 1000, maxPerDay: 2, db })).toMatchObject({ ok: false, reason: "limited" });
    expect((await claimNextActionWrite(A, { nowMs: Date.parse("2026-11-27T00:00:00.000Z"), leaseMs: 1000, maxPerDay: 2, db })).ok).toBe(true);
  });

  it("never reads or writes another brand's record, and refuses one at its id", async () => {
    await claimNextActionWrite(A, { nowMs: T0, leaseMs: 1000, db });
    expect(await readNextActionCard(B, { db })).toBeNull();
    expect(await forgetNextActionCard(B, { at: iso(T0), by: { type: "member", id: "usr_b" }, db })).toBe(false);
    expect(await readNextActionCard(A, { db })).not.toBeNull();
    db.seed("next_action_cards", nextActionDocId("ten_B"), { tenantId: "ten_A", status: "fallback" });
    await expect(readNextActionCard(B, { db })).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(claimNextActionWrite(B, { nowMs: T0, leaseMs: 1000, db })).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it("reads a damaged record as none, and writes it again", async () => {
    db.seed("next_action_cards", nextActionDocId("ten_A"), { tenantId: "ten_A", status: "something", outcomes: "no" });
    expect(await readNextActionCard(A, { db })).toBeNull();
    expect((await claimNextActionWrite(A, { nowMs: T0, leaseMs: 1000, db })).ok).toBe(true);
    expect((await readNextActionCard(A, { db }))!.status).toBe("fallback");
  });

  it("keeps the newest 30 outcomes, none older than 90 days", () => {
    const many = Array.from({ length: 40 }, (_, i) => outcome(1, i));
    const kept = trimOutcomes([outcome(91), ...many], T0);
    expect(kept).toHaveLength(30);
    expect(kept[0]!.title).toBe("t0");
    expect(kept.some((o) => Date.parse(o.at) < T0 - 90 * 86_400_000)).toBe(false);
  });

  it("keeps a dismissal within its 30 quiet days however many outcomes came after it, newest per step", () => {
    const dismissed = outcome(5, 0, { state: "dismissed", actionKey: "ask.waitlist_page", title: "Start a list", reason: "We have one" });
    const older = outcome(10, 0, { state: "dismissed", actionKey: "ask.waitlist_page" });
    const stale = outcome(31, 0, { state: "dismissed", actionKey: "page.review" });
    const after = Array.from({ length: 40 }, (_, i) => outcome(1, i));
    const kept = trimOutcomes([dismissed, older, stale, ...after], T0);
    expect(kept).toHaveLength(31);
    expect(kept.filter((o) => o.state === "dismissed")).toEqual([dismissed]);
    // Newest first, still.
    expect(kept.map((o) => o.at)).toEqual([...kept.map((o) => o.at)].sort().reverse());
  });

  it("never reads an outcome older than 90 days, even before the record is written again", async () => {
    const c = await claimNextActionWrite(A, { nowMs: T0, leaseMs: 1000, db });
    if (!c.ok) throw new Error("claim");
    await commitNextActionWrite(A, fallback(c.leaseId, T0), { db });
    // Outcomes as they stood on the last write, one with a reason now 91 days old.
    await db.collection("next_action_cards").doc(nextActionDocId("ten_A")).update({ outcomes: [outcome(-1, 0, { state: "dismissed", reason: "Old words" }), outcome(0)] });
    const later = T0 + 92 * 86_400_000;
    expect((await readNextActionCard(A, { db, nowMs: T0 }))!.outcomes).toHaveLength(2);
    expect((await readNextActionCard(A, { db, nowMs: later }))!.outcomes).toEqual([]);
    const claim = await claimNextActionWrite(A, { nowMs: later, leaseMs: 1000, db });
    expect(claim.record!.outcomes).toEqual([]);
  });

  it("counts a call that wrote no card toward the day, when asked", async () => {
    for (let i = 0; i < 2; i += 1) {
      const c = await claimNextActionWrite(A, { nowMs: T0 + i * 60_000, leaseMs: 1000, maxPerDay: 2, db });
      if (!c.ok) throw new Error("claim");
      await releaseNextActionWrite(A, c.leaseId, { db, spentAt: T0 + i * 60_000 + 10 });
    }
    expect(await claimNextActionWrite(A, { nowMs: T0 + 3 * 60_000, leaseMs: 1000, maxPerDay: 2, db })).toMatchObject({ ok: false, reason: "limited" });
  });

  it("forgetting the card keeps the day's count, so removing a fact never buys more cards", async () => {
    for (let i = 0; i < 2; i += 1) {
      const c = await claimNextActionWrite(A, { nowMs: T0 + i * 60_000, leaseMs: 1000, maxPerDay: 2, db });
      if (!c.ok) throw new Error("claim");
      await commitNextActionWrite(A, fallback(c.leaseId, T0 + i * 60_000 + 10), { db });
    }
    expect(await forgetNextActionCard(A, { at: iso(T0 + 2 * 60_000), by: { type: "member", id: "usr_a" }, db })).toBe(true);
    expect(await claimNextActionWrite(A, { nowMs: T0 + 3 * 60_000, leaseMs: 1000, maxPerDay: 2, db })).toMatchObject({ ok: false, reason: "limited" });
  });

  it("forgetting the card drops every word and keeps only which steps were dismissed, and a write in progress loses its hold", async () => {
    const c = await claimNextActionWrite(A, { nowMs: T0, leaseMs: 45_000, db });
    if (!c.ok) throw new Error("claim");
    const s1 = await propose("nc_0000000000000001", "s1", "page.create_launch", T0);
    await commitNextActionWrite(A, { ...fallback(c.leaseId, T0 + 10), status: "card", cardId: "nc_0000000000000001", card: CARD, steps: [s1], failure: null }, { db });
    await recordNextActionOutcome(A, { cardId: "nc_0000000000000001", step: "s1", outcome: "dismissed", reason: "We did this already", choice: null, by: { type: "member", id: "usr_a" }, at: iso(T0 + 20) }, { db });
    const held = await claimNextActionWrite(A, { nowMs: T0 + 30, leaseMs: 45_000, db });
    if (!held.ok) throw new Error("claim");
    await forgetNextActionCard(A, { at: iso(T0 + 40), by: { type: "member", id: "usr_a" }, db });
    const rec = (await readNextActionCard(A, { db, nowMs: T0 + 50 }))!;
    expect(rec).toMatchObject({ status: "fallback", inputHash: "", card: null, cardId: null, steps: [], leaseId: null, composeCount: 1 });
    expect(rec.outcomes).toEqual([{ at: iso(T0 + 20), cardId: "nc_0000000000000001", step: "s1", actionKey: "page.create_launch", title: "", state: "dismissed", reason: null, answer: null }]);
    const raw = JSON.stringify((await db.collection("next_action_cards").doc(nextActionDocId("ten_A")).get()).data());
    expect(raw).toContain("page.create_launch");
    expect(raw).not.toContain("We did this already");
    expect(raw).not.toContain(CARD.steps[0]!.title);
    expect(await commitNextActionWrite(A, { ...fallback(held.leaseId, T0 + 60) }, { db })).toEqual({ ok: false, reason: "lost" });
    expect(quietOnly([outcome(31, 0, { state: "dismissed" }), outcome(1)], T0)).toEqual([]);
  });

  it("records a goal the brand reached as done when a new card replaces it, not as ignored", async () => {
    const c = await claimNextActionWrite(A, { nowMs: T0, leaseMs: 45_000, db });
    if (!c.ok) throw new Error("claim");
    const goal: ActionCard = {
      type: "ActionCard",
      v: 1,
      steps: [
        CARD.steps[0]!,
        { type: "Step", key: "s2", title: "Your goal: 4 newsletters", why: "You said one a week.", action: null, button: null, choices: null, progress: { type: "Progress", metric: "newsletters", target: 4 } },
      ],
      note: null,
    };
    const steps = [await propose("nc_0000000000000001", "s1", "page.create_launch", T0), await propose("nc_0000000000000001", "s2", "goal.newsletters", T0)];
    await commitNextActionWrite(A, { ...fallback(c.leaseId, T0 + 10), status: "card", cardId: "nc_0000000000000001", card: goal, steps, failure: null }, { db });
    const next = await claimNextActionWrite(A, { nowMs: T0 + 60_000, leaseMs: 45_000, db });
    if (!next.ok) throw new Error("claim");
    await commitNextActionWrite(A, { ...fallback(next.leaseId, T0 + 60_010), reached: ["s2"] }, { db });
    const rec = (await readNextActionCard(A, { db, nowMs: T0 + 60_020 }))!;
    expect(rec.outcomes.map((o) => [o.step, o.state])).toEqual([
      ["s2", "done"],
      ["s1", "ignored"],
    ]);
    expect(await getAgentAction(A, steps[1]!.agentActionId, { db })).toMatchObject({ state: "acted", actedBy: { type: "system", id: "next_action" }, result: { outcome: "done", goal: "reached" } });
    expect(await getAgentAction(A, steps[0]!.agentActionId, { db })).toMatchObject({ state: "declined", declined: { reason: "superseded" } });
  });
});
