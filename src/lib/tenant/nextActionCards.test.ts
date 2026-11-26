import { beforeEach, describe, expect, it } from "vitest";
import { TenantIsolationError } from "./errors";
import { claimNextActionWrite, commitNextActionWrite, forgetNextActionCard, readNextActionCard, releaseNextActionWrite, trimOutcomes } from "./nextActionCards";
import { FakeFirestore } from "./testing/fakeFirestore";
import { timestampFirestore } from "./testing/timestampFirestore";
import type { TenantContext } from "./types";
import { nextActionDocId, type ActionCard, type Outcome } from "@/lib/types/nextAction";

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

function outcome(daysAgo: number, i = 0): Outcome {
  return { at: iso(T0 - daysAgo * 86_400_000 - i), cardId: "nc_0000000000000001", step: "s1", actionKey: "page.create_launch", title: `t${i}`, state: "ignored", reason: null, answer: null };
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
});
