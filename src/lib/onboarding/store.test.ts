import { describe, expect, it } from "vitest";
import { forTenant, getTenantById, TenantIsolationError } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { ONBOARDING_LIMITS, type Learned, type VoiceTurn } from "@/lib/types/onboarding";
import {
  appendTurns,
  closeStaleConversations,
  confirmLearned,
  deleteConversation,
  endConversation,
  getConversation,
  listBusinessFacts,
  listConversations,
  mayLearn,
  removeBusinessFact,
  saveLearned,
  startConversation,
} from "./store";

// Made-up brands and people. Dates are kept as ISO strings, so they read back the same from
// Firestore (the timestamp fake proves it below).
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a1", role: "admin" };
const A2: TenantContext = { ...A, userId: "usr_a2" };
const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "idtoken", userId: "usr_b1", role: "admin" };
const T0 = Date.parse("2026-11-25T10:00:00.000Z");

function brandDb(): FakeFirestore {
  const db = new FakeFirestore();
  for (const id of ["ten_A", "ten_B"]) {
    db.seed("tenants", id, {
      tenantName: `Brand ${id}`,
      rootDomain: `${id}.example.com`,
      status: "active",
      region: "us",
      allowedOrigins: [`https://${id}.example.com`],
      ownerId: "usr_owner",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  }
  return db;
}

const deps = (db: FakeFirestore, at = T0) => ({ db, now: () => at });
const say = (who: "m" | "v", text: string, atSec = 0): VoiceTurn => ({ who: who === "m" ? "member" : "vizzy", text, atSec });

async function started(db: FakeFirestore, ctx = A, at = T0) {
  const r = await startConversation(ctx, { model: "live-model" }, deps(db, at));
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const LEARNED: Learned = {
  answers: {
    who: { value: "team", words: "It's me and two others." },
    run: { value: "shop", words: "We run a little plant shop" },
    stage: { value: null, words: "" },
    want: { value: "audience", words: "We want more people to know us" },
  },
  facts: [
    { id: "f0", kind: "timeline", text: "Launch before the Christmas markets", quote: "We want a gift box out before the Christmas markets start." },
    { id: "f1", kind: "channel", text: "Sells at three farmers' markets", quote: "We sell at three farmers' markets most weekends." },
    { id: "f2", kind: "start", text: "No email list yet", quote: "We've never had an email list." },
  ],
  model: "text-model",
  at: "2026-11-25T10:05:00.000Z",
};

/** A conversation that ended and learned LEARNED. */
async function learnedConversation(db: FakeFirestore, ctx = A) {
  const c = await started(db, ctx);
  await appendTurns(ctx, c.id, { from: 0, turns: [say("v", "Hi!"), say("m", "It's me and two others.", 4)] }, deps(db, T0 + 10_000));
  await endConversation(ctx, c.id, { reason: "person" }, deps(db, T0 + 60_000));
  await saveLearned(ctx, c.id, LEARNED, deps(db, T0 + 65_000));
  return c.id;
}

describe("kept conversations", () => {
  it("keeps each brand's conversations and facts to itself", async () => {
    const db = brandDb();
    const id = await learnedConversation(db);
    await confirmLearned(A, id, { answers: { who: "team" }, keep: ["f0"] }, deps(db));
    const [fact] = await listBusinessFacts(A, deps(db));

    expect(await getConversation(B, id, deps(db))).toBeNull();
    expect(await listConversations(B, deps(db))).toEqual([]);
    expect(await listBusinessFacts(B, deps(db))).toEqual([]);
    expect(await forTenant(B, db).onboardingConversations.count()).toBe(0);
    expect(await deleteConversation(B, id, deps(db))).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(await removeBusinessFact(B, fact!.id, deps(db))).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(await appendTurns(B, id, { from: 2, turns: [say("m", "Hijack")] }, deps(db))).toEqual({ ok: false, status: 404, error: "not_found" });
    await expect(forTenant(B, db).onboardingConversations.delete(id)).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(forTenant(B, db).businessFacts.delete(fact!.id)).rejects.toBeInstanceOf(TenantIsolationError);
    expect(await getConversation(A, id, deps(db))).not.toBeNull();
    expect(await listBusinessFacts(A, deps(db))).toHaveLength(1);
  });

  it("starts live for the member, with a window, and refuses a 21st", async () => {
    const db = brandDb();
    const c = await started(db);
    expect(c).toMatchObject({ tenantId: "ten_A", by: "usr_a1", source: "voice", status: "live", turns: [], learned: null, learnTries: 0, confirmedAt: null });
    expect(c.id).toMatch(/^oc_[a-f0-9]{32}$/);
    expect(Date.parse(c.expiresAt) - Date.parse(c.startedAt)).toBe(ONBOARDING_LIMITS.LIVE_WINDOW_MS);
    for (let i = 1; i < 20; i += 1) await started(db);
    expect(await startConversation(A, { model: "m" }, deps(db))).toEqual({ ok: false, status: 409, error: "too_many_conversations" });
    expect((await startConversation(B, { model: "m" }, deps(db))).ok).toBe(true);
    expect(await startConversation({ ...A, userId: undefined }, { model: "m" }, deps(db))).toMatchObject({ ok: false, status: 401 });
  });

  it("appends in order, refuses a gap, and a repeat changes nothing", async () => {
    const db = brandDb();
    const c = await started(db);
    const first = [say("v", "Hi! What are you working on?", 0), say("m", "  A little\nplant shop. ", 3)];
    expect(await appendTurns(A, c.id, { from: 0, turns: first }, deps(db))).toEqual({ ok: true, value: { length: 2 } });
    const writes = db.writeCountFor("onboarding_conversations", c.id);
    expect(await appendTurns(A, c.id, { from: 0, turns: first }, deps(db))).toEqual({ ok: true, value: { length: 2 } });
    expect(db.writeCountFor("onboarding_conversations", c.id)).toBe(writes);
    expect(await appendTurns(A, c.id, { from: 3, turns: [say("v", "Gap")] }, deps(db))).toEqual({ ok: false, status: 409, error: "out_of_order", length: 2 });
    expect(await appendTurns(A, c.id, { from: 1, turns: [say("m", "Something else")] }, deps(db))).toMatchObject({ status: 409, error: "out_of_order" });
    // An overlap that matches adds only what's new.
    expect(await appendTurns(A, c.id, { from: 1, turns: [first[1]!, say("v", "Lovely.", 9)] }, deps(db))).toEqual({ ok: true, value: { length: 3 } });
    const kept = await getConversation(A, c.id, deps(db));
    expect(kept?.turns).toEqual([
      { who: "vizzy", text: "Hi! What are you working on?", atSec: 0 },
      { who: "member", text: "A little plant shop.", atSec: 3 },
      { who: "vizzy", text: "Lovely.", atSec: 9 },
    ]);
    expect(kept?.chars).toBe("Hi! What are you working on?".length + "A little plant shop.".length + "Lovely.".length);
  });

  it("keeps Vizzy's notes as hints, skipping one that repeats its topic's latest", async () => {
    const db = brandDb();
    const c = await started(db);
    await appendTurns(A, c.id, { from: 0, turns: [say("m", "Just me.")], notes: [{ topic: "who", choice: "solo", words: "Just me." }] }, deps(db));
    await appendTurns(A, c.id, { from: 0, turns: [say("m", "Just me.")], notes: [{ topic: "who", choice: "solo", words: "Just me." }] }, deps(db));
    expect((await getConversation(A, c.id, deps(db)))?.notes).toEqual([{ topic: "who", choice: "solo", words: "Just me.", at: new Date(T0).toISOString() }]);
  });

  it("only the member who started it adds words, and not after it ends or its window passes", async () => {
    const db = brandDb();
    const c = await started(db);
    expect(await appendTurns(A2, c.id, { from: 0, turns: [say("m", "Me too")] }, deps(db))).toEqual({ ok: false, status: 403, error: "not_yours" });
    expect(await endConversation(A2, c.id, { reason: "person" }, deps(db))).toMatchObject({ ok: false, status: 403, error: "not_yours" });
    const late = T0 + ONBOARDING_LIMITS.LIVE_WINDOW_MS + 1;
    expect(await appendTurns(A, c.id, { from: 0, turns: [say("m", "Late")] }, deps(db, late))).toEqual({ ok: false, status: 409, error: "conversation_closed" });

    const d = await started(db);
    await endConversation(A, d.id, { reason: "person" }, deps(db));
    expect(await appendTurns(A, d.id, { from: 0, turns: [say("m", "After")] }, deps(db))).toEqual({ ok: false, status: 409, error: "conversation_closed" });
  });

  it("refuses past 200 turns or 40,000 characters", async () => {
    const db = brandDb();
    const c = await started(db);
    let from = 0;
    while (from < 200) {
      const turns = Array.from({ length: 20 }, (_, i) => say(i % 2 ? "m" : "v", `Line ${from + i}`));
      const r = await appendTurns(A, c.id, { from, turns }, deps(db));
      expect(r.ok).toBe(true);
      from += 20;
    }
    expect(await appendTurns(A, c.id, { from: 200, turns: [say("m", "One more")] }, deps(db))).toEqual({ ok: false, status: 413, error: "conversation_full" });

    const d = await started(db);
    const long = "x".repeat(2_000);
    for (let i = 0; i < 20; i += 1) {
      expect((await appendTurns(A, d.id, { from: i, turns: [say("m", long)] }, deps(db))).ok).toBe(true);
    }
    expect(await appendTurns(A, d.id, { from: 20, turns: [say("m", "y")] }, deps(db))).toEqual({ ok: false, status: 413, error: "conversation_full" });
  });

  it("ends once, with the last upload and the call's length, and ending again says so", async () => {
    const db = brandDb();
    const c = await started(db);
    await appendTurns(A, c.id, { from: 0, turns: [say("v", "Hi!", 0)] }, deps(db));
    const r = await endConversation(
      A,
      c.id,
      { reason: "time", final: { from: 1, turns: [say("m", "We sell plants.", 240), say("v", "Thanks.", 252)], notes: [{ topic: "run", choice: "shop" }] } },
      deps(db, T0 + 300_000),
    );
    expect(r.ok && r.value.already).toBe(false);
    const ended = r.ok ? r.value.conversation : null;
    expect(ended).toMatchObject({ status: "ended", endReason: "time", lengthSec: 252, endedAt: new Date(T0 + 300_000).toISOString() });
    expect(ended?.turns).toHaveLength(3);
    expect(ended?.notes).toHaveLength(1);
    const again = await endConversation(A, c.id, { reason: "person" }, deps(db, T0 + 400_000));
    expect(again.ok && again.value.already).toBe(true);
    expect((await getConversation(A, c.id, deps(db)))?.endReason).toBe("time");
  });

  it("never counts a call longer than it was open, and drops a last upload with a gap", async () => {
    const db = brandDb();
    const c = await started(db);
    const r = await endConversation(A, c.id, { reason: "person", final: { from: 5, turns: [say("m", "Lost", 600)] } }, deps(db, T0 + 30_000));
    expect(r.ok && r.value.conversation).toMatchObject({ lengthSec: 0, turns: [] });
    const d = await started(db);
    const s = await endConversation(A, d.id, { reason: "person", final: { from: 0, turns: [say("m", "Quick", 600)] } }, deps(db, T0 + 30_000));
    expect(s.ok && s.value.conversation.lengthSec).toBe(30);
  });

  it("closes a live conversation whose window passed, as of its window's end", async () => {
    const db = brandDb();
    const old = await started(db);
    const fresh = await started(db, A, T0 + 7 * 60_000);
    const closed = await closeStaleConversations(A, deps(db, T0 + 9 * 60_000));
    expect(closed.map((c) => c.id)).toEqual([old.id]);
    expect(closed[0]).toMatchObject({ status: "ended", endReason: "closed", endedAt: old.expiresAt });
    expect((await getConversation(A, fresh.id, deps(db)))?.status).toBe("live");
  });

  it("sets the seconds to count once, as it ends: the time open by the server's clock, at most 6 minutes", async () => {
    const db = brandDb();
    const c = await started(db);
    const r = await endConversation(A, c.id, { reason: "person" }, deps(db, T0 + 252_400));
    expect(r.ok && r.value.conversation.meteredSeconds).toBe(252);
    // Ending again leaves them as they were.
    const again = await endConversation(A, c.id, { reason: "person" }, deps(db, T0 + 600_000));
    expect(again.ok && again.value.conversation.meteredSeconds).toBe(252);
    const long = await started(db);
    const late = await endConversation(A, long.id, { reason: "time" }, deps(db, T0 + 7 * 60_000));
    expect(late.ok && late.value.conversation.meteredSeconds).toBe(ONBOARDING_LIMITS.MAX_CALL_SEC);
    // A call left open counts what it evidently ran: its last line, or nothing without one.
    const open = await started(db);
    await appendTurns(A, open.id, { from: 0, turns: [say("v", "Hi there", 1), say("m", "We sell plants", 140)] }, deps(db, T0 + 150_000));
    const silent = await started(db);
    const closed = await closeStaleConversations(A, deps(db, T0 + 30 * 60_000));
    expect(closed.find((c) => c.id === open.id)).toMatchObject({ lengthSec: 140, meteredSeconds: 140 });
    expect(closed.find((c) => c.id === silent.id)).toMatchObject({ lengthSec: 0, meteredSeconds: 0 });
    // A chat counts none.
    const chat = await startConversation(A, { model: "text-model", source: "chat" }, deps(db));
    const ended = chat.ok ? await endConversation(A, chat.value.id, { reason: "person" }, deps(db, T0 + 90_000)) : null;
    expect(ended?.ok && ended.value.conversation.meteredSeconds).toBe(0);
  });

  it("keeps what learning gave once, counting each try", async () => {
    const db = brandDb();
    const c = await started(db);
    expect(await saveLearned(A, c.id, LEARNED, deps(db))).toEqual({ ok: false, status: 409, error: "not_ended" });
    await endConversation(A, c.id, { reason: "person" }, deps(db));
    const first = await saveLearned(A, c.id, null, deps(db));
    expect(first.ok && first.value).toMatchObject({ learned: null, learnTries: 1 });
    expect(first.ok && mayLearn(first.value)).toBe(true);
    const second = await saveLearned(A, c.id, LEARNED, deps(db));
    expect(second.ok && second.value).toMatchObject({ learnTries: 2, learned: { facts: expect.any(Array) } });
    expect(second.ok && mayLearn(second.value)).toBe(false);
    const third = await saveLearned(A, c.id, { ...LEARNED, facts: [] }, deps(db));
    expect(third.ok && third.value.learned?.facts).toHaveLength(3);
    expect(mayLearn({ status: "ended", learned: null, learnTries: 3, confirmedAt: null })).toBe(false);
  });

  it("lists the brand's conversations newest first, without words, reading with no orderBy", async () => {
    const db = brandDb();
    const ops: string[] = [];
    const shaped = shapeRecordingFirestore(db, ops);
    const older = await started(db, A, T0);
    const newer = await started(db, A, T0 + 60_000);
    await appendTurns(A, newer.id, { from: 0, turns: [say("m", "Hello there")] }, deps(db, T0 + 61_000));
    const list = await listConversations(A, { db: shaped });
    expect(list.map((c) => c.id)).toEqual([newer.id, older.id]);
    expect(list[0]).toEqual({ id: newer.id, source: "voice", status: "live", startedAt: newer.startedAt, endedAt: null, lengthSec: 0, turnCount: 1, waiting: false });
    expect(JSON.stringify(list)).not.toContain("Hello there");
    expect(ops).toEqual(["where tenantId =="]);
  });

  it("deleting a conversation removes its words and what was learned, and keeps the facts kept from it", async () => {
    const db = brandDb();
    const id = await learnedConversation(db);
    await confirmLearned(A, id, { answers: {}, keep: ["f0", "f1"] }, deps(db));
    expect(await deleteConversation(A, id, deps(db))).toEqual({ ok: true, value: true });
    expect(db.raw("onboarding_conversations", id)).toBeUndefined();
    expect(await deleteConversation(A, id, deps(db))).toEqual({ ok: false, status: 404, error: "not_found" });
    expect((await listBusinessFacts(A, deps(db))).map((f) => f.conversationId)).toEqual([id, id]);
  });

  it("reads back the same from a database that keeps dates as Timestamps", async () => {
    const db = brandDb();
    const ts = timestampFirestore(db);
    const id = await learnedConversation(ts);
    await confirmLearned(A, id, { answers: {}, keep: ["f2"] }, deps(ts));
    const [fact] = await listBusinessFacts(A, deps(ts));
    expect(typeof fact?.heardAt).toBe("string");
    expect((await listConversations(A, deps(ts)))[0]?.startedAt).toBe(new Date(T0).toISOString());
  });
});

describe("confirming what was learned", () => {
  it("keeps only the picked ids, copied from the stored learning, and saves the answers as done from the call", async () => {
    const db = brandDb();
    const id = await learnedConversation(db);
    const r = await confirmLearned(A, id, { answers: { who: "team", run: "service" }, keep: ["f2", "f0", "f7", "f0"] }, deps(db, T0 + 90_000));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kept.map((f) => f.text)).toEqual(["Launch before the Christmas markets", "No email list yet"]);
    expect(r.value.kept[0]).toMatchObject({
      tenantId: "ten_A",
      kind: "timeline",
      quote: LEARNED.facts[0]!.quote,
      source: "voice",
      conversationId: id,
      heardAt: new Date(T0).toISOString(),
      confirmedAt: new Date(T0 + 90_000).toISOString(),
    });
    expect(r.value.kept[0]!.id).toMatch(/^bf_[a-f0-9]{16}$/);
    expect(r.value.before).toBeNull();
    expect(r.value.profile).toMatchObject({ status: "done", via: "voice", answers: { who: "team", run: "service" } });
    // Answers changed (rev 1), then the kept facts (rev 2): Vizzy reads the profile again.
    expect(r.value.profile?.rev).toBe(2);
    expect((await getTenantById("ten_A", db))?.businessProfile?.rev).toBe(2);
    expect((await getConversation(A, id, deps(db)))?.confirmedAt).toBe(new Date(T0 + 90_000).toISOString());
    expect((await listBusinessFacts(A, deps(db))).map((f) => f.kind)).toEqual(["timeline", "start"]);
  });

  it("refuses a conversation that hasn't ended, and one of another brand", async () => {
    const db = brandDb();
    const c = await started(db);
    expect(await confirmLearned(A, c.id, { answers: {}, keep: [] }, deps(db))).toEqual({ ok: false, status: 409, error: "not_ended" });
    const id = await learnedConversation(db);
    expect(await confirmLearned(B, id, { answers: {}, keep: ["f0"] }, deps(db))).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(await listBusinessFacts(B, deps(db))).toEqual([]);
  });

  it("skips a fact with the same words as one already kept, ignoring case and punctuation", async () => {
    const db = brandDb();
    const first = await learnedConversation(db);
    await confirmLearned(A, first, { answers: {}, keep: ["f1"] }, deps(db));
    const second = await learnedConversation(db);
    await forTenant(A, db).onboardingConversations.update(second, {
      learned: { ...LEARNED, facts: [{ id: "f0", kind: "channel", text: "Three markets", quote: "we sell at three farmers markets, most weekends" }] },
    });
    const r = await confirmLearned(A, second, { answers: {}, keep: ["f0"] }, deps(db));
    expect(r.ok && r.value).toMatchObject({ kept: [], duplicate: 1, full: false });
    expect(await listBusinessFacts(A, deps(db))).toHaveLength(1);
  });

  it("stops at 40 facts for the brand", async () => {
    const db = brandDb();
    for (let i = 0; i < 39; i += 1) {
      db.seed("business_facts", `bf_${i.toString(16).padStart(16, "0")}`, {
        tenantId: "ten_A",
        kind: "goal",
        text: `Goal ${i}`,
        quote: `A goal we have, number ${i}`,
        source: "voice",
        conversationId: null,
        heardAt: "2026-11-01T00:00:00.000Z",
        confirmedAt: "2026-11-01T00:00:00.000Z",
        createdAt: `2026-11-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    const id = await learnedConversation(db);
    const r = await confirmLearned(A, id, { answers: {}, keep: ["f0", "f1", "f2"] }, deps(db));
    expect(r.ok && r.value).toMatchObject({ full: true });
    expect(r.ok && r.value.kept).toHaveLength(1);
    expect(await listBusinessFacts(A, deps(db))).toHaveLength(40);
  });

  it("confirming twice adds nothing", async () => {
    const db = brandDb();
    const id = await learnedConversation(db);
    await confirmLearned(A, id, { answers: { who: "team" }, keep: ["f0"] }, deps(db));
    const again = await confirmLearned(A, id, { answers: { who: "agency" }, keep: ["f0", "f1", "f2"] }, deps(db));
    expect(again.ok && again.value).toMatchObject({ repeat: true, kept: [], profile: { answers: { who: "team" } } });
    expect(await listBusinessFacts(A, deps(db))).toHaveLength(1);
  });

  it("a confirm with nothing learned saves the answers and keeps no fact", async () => {
    const db = brandDb();
    const c = await started(db);
    await endConversation(A, c.id, { reason: "person" }, deps(db));
    const r = await confirmLearned(A, c.id, { answers: { want: "waitlist" }, keep: ["f0"] }, deps(db));
    expect(r.ok && r.value).toMatchObject({ kept: [], profile: { status: "done", answers: { want: "waitlist" } } });
  });
});

describe("removing a fact", () => {
  it("deletes its words, only in this brand, and Vizzy reads the profile again", async () => {
    const db = brandDb();
    const id = await learnedConversation(db);
    const r = await confirmLearned(A, id, { answers: {}, keep: ["f0", "f1"] }, deps(db));
    const [first] = r.ok ? r.value.kept : [];
    const rev = (await getTenantById("ten_A", db))?.businessProfile?.rev ?? 0;
    expect(await removeBusinessFact(A, first!.id, deps(db))).toEqual({ ok: true, value: true });
    expect(db.raw("business_facts", first!.id)).toBeUndefined();
    expect(await listBusinessFacts(A, deps(db))).toHaveLength(1);
    expect((await getTenantById("ten_A", db))?.businessProfile?.rev).toBe(rev + 1);
    expect(await removeBusinessFact(A, first!.id, deps(db))).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(await removeBusinessFact(A, "bf_nothex", deps(db))).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});
