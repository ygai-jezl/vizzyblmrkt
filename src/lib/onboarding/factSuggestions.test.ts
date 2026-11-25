import { describe, expect, it } from "vitest";
import { forTenant, getTenantById, proposeAgentAction } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { readsFirst } from "@/lib/tenant/testing/readsFirst";
import type { TenantContext } from "@/lib/tenant/types";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { AgentActionId } from "@/lib/types/agentAction";
import { ONBOARDING_LIMITS } from "@/lib/types/onboarding";
import {
  ABOUT_HREF,
  BUSINESS_FACT_ACTION,
  MAX_WAITING,
  businessFactReviewItem,
  decideBusinessFact,
  factHash,
  keptChatTurns,
  openFactSuggestions,
  suggestBusinessFact,
  type FactSuggestionInput,
} from "./factSuggestions";
import { listBusinessFacts, listConversations } from "./store";
import { SUGGESTION_WORDS } from "./words";

// Made-up brands and people. Dates are ISO strings, so they read back the same from Firestore.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_a1", role: "admin" };
const A2: TenantContext = { ...A, source: "idtoken", userId: "usr_a2" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "agent", userId: "usr_b1", role: "admin" };
const T0 = Date.parse("2026-11-25T10:00:00.000Z");
const DAY = 86_400_000;

const MARKETS: FactSuggestionInput = {
  kind: "channel",
  text: "Sells at three farmers' markets",
  quote: "We sell at three farmers' markets most weekends.",
  asked: "Where do people buy from you today?",
};

function brandDb(opts: { profile?: boolean } = {}): FakeFirestore {
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
      ...(opts.profile === false ? {} : { businessProfile: { status: "done", answers: { run: "shop" }, rev: 2, startedAt: "2026-11-01T00:00:00.000Z" } }),
    });
  }
  return db;
}

async function suggested(db: FakeFirestore, input = MARKETS, ctx = A, nowMs = T0) {
  const r = await suggestBusinessFact(ctx, input, { db, nowMs });
  if (!r.ok) throw new Error(r.error);
  return r;
}

const fact = (i: number): FactSuggestionInput => ({ kind: "goal", text: `Goal number ${i} for the shop`, quote: `We want to reach goal number ${i} this year.` });

describe("suggestBusinessFact", () => {
  it("saves a suggestion about the brand itself that waits for an admin, and clears its words once decided", async () => {
    const db = brandDb();
    const r = await suggested(db);
    expect(r.outcome).toBe("created");
    const action = await getAgentAction(A, r.fact.id, { db });
    expect(action).toMatchObject({
      agent: "vizzy",
      action: BUSINESS_FACT_ACTION,
      target: { type: "brand", id: "ten_A" },
      personId: null,
      state: "proposed",
      review: { kind: "business_fact", href: ABOUT_HREF },
      requestedBy: { type: "member", id: "usr_a1" },
      clearDetailsOnClose: true,
      proposal: { kind: "channel", text: MARKETS.text, quote: MARKETS.quote, asked: MARKETS.asked },
    });
    expect(Date.parse(action!.expiresAt) - T0).toBe(30 * DAY);
    // The dedupe key names a hash of the words, never the words.
    expect(action!.dedupeKey).toBe(`${BUSINESS_FACT_ACTION}|${factHash("channel", MARKETS.text)}`);
    expect(action!.dedupeKey).not.toMatch(/market/i);
    expect(await openFactSuggestions(A, { db, nowMs: T0 })).toEqual([
      { id: r.fact.id, rev: 1, kind: "channel", text: MARKETS.text, quote: MARKETS.quote, asked: MARKETS.asked, at: new Date(T0).toISOString() },
    ]);
  });

  it("answers with the one waiting for the same fact again, ignoring case and punctuation", async () => {
    const db = brandDb();
    const first = await suggested(db);
    const again = await suggested(db, { ...MARKETS, text: "sells at three farmers markets!", quote: "Most weekends we sell at markets." }, A, T0 + 1000);
    expect(again).toMatchObject({ outcome: "open", fact: { id: first.fact.id } });
    expect(await openFactSuggestions(A, { db, nowMs: T0 + 1000 })).toHaveLength(1);
  });

  it("refuses words already kept, from a call or a chat", async () => {
    const db = brandDb();
    await forTenant(A, db).businessFacts.create("bf_0000000000000001", {
      kind: "start",
      text: "No email list yet",
      quote: "We've never had an email list.",
      source: "voice",
      conversationId: null,
      heardAt: "2026-11-24T10:00:00.000Z",
      confirmedAt: "2026-11-24T10:05:00.000Z",
      createdAt: "2026-11-24T10:05:00.000Z",
    });
    expect(await suggestBusinessFact(A, { kind: "start", text: "no email list yet.", quote: "Nothing yet, not even a list of emails." }, { db, nowMs: T0 })).toEqual({
      ok: false,
      error: "already_known",
    });
    expect(await suggestBusinessFact(A, { kind: "constraint", text: "Never had a list", quote: "we've never had an email list" }, { db, nowMs: T0 })).toEqual({
      ok: false,
      error: "already_known",
    });
  });

  it("says a fact a person removed or kept is already decided, and saves nothing", async () => {
    const db = brandDb();
    const r = await suggested(db);
    expect(await decideBusinessFact(A2, r.fact.id, "remove", { db, nowMs: T0 + 1000 })).toEqual({ ok: true, decision: "remove" });
    expect(await suggestBusinessFact(A, MARKETS, { db, nowMs: T0 + 2000 })).toEqual({ ok: false, error: "already_decided" });
    expect(await openFactSuggestions(A, { db, nowMs: T0 + 2000 })).toEqual([]);
  });

  it("can suggest it again once the last one ran out of time with nobody deciding", async () => {
    const db = brandDb();
    const first = await suggested(db);
    const later = T0 + 31 * DAY;
    expect(await openFactSuggestions(A, { db, nowMs: later })).toEqual([]);
    const again = await suggested(db, MARKETS, A, later);
    expect(again.outcome).toBe("created");
    expect(again.fact.id).not.toBe(first.fact.id);
    expect((await getAgentAction(A, again.fact.id, { db }))?.dedupeKey).toMatch(/\|r1$/);
  });

  it("keeps at most 10 waiting, and at most 40 facts kept and waiting together", async () => {
    const db = brandDb();
    for (let i = 0; i < MAX_WAITING; i += 1) await suggested(db, fact(i), A, T0 + i);
    expect(await suggestBusinessFact(A, fact(99), { db, nowMs: T0 + 100 })).toEqual({ ok: false, error: "too_many_waiting" });

    const full = brandDb();
    for (let i = 0; i < ONBOARDING_LIMITS.MAX_FACTS - 1; i += 1) {
      await forTenant(A, full).businessFacts.create(`bf_${String(i).padStart(16, "0")}`, {
        kind: "goal",
        text: `Kept goal ${i}`,
        quote: `A kept goal that is number ${i}.`,
        source: "voice",
        conversationId: null,
        heardAt: "2026-11-24T10:00:00.000Z",
        confirmedAt: "2026-11-24T10:05:00.000Z",
        createdAt: "2026-11-24T10:05:00.000Z",
      });
    }
    await suggested(full, fact(1));
    expect(await suggestBusinessFact(A, fact(2), { db: full, nowMs: T0 })).toEqual({ ok: false, error: "too_many_facts" });
  });

  it("never shows one brand another brand's suggestions", async () => {
    const db = brandDb();
    await suggested(db);
    expect(await openFactSuggestions(B, { db, nowMs: T0 })).toEqual([]);
    // The same words in brand B are B's own suggestion.
    const b = await suggested(db, MARKETS, B);
    expect(b.outcome).toBe("created");
    expect((await openFactSuggestions(A, { db, nowMs: T0 })).map((w) => w.id)).not.toContain(b.fact.id);
  });
});

describe("decideBusinessFact", () => {
  it("Keep writes the fact, the chat's three lines and the decision together, and Vizzy reads the profile again", async () => {
    const fake = brandDb();
    const db = readsFirst(fake);
    const r = await suggested(fake);
    const kept = await decideBusinessFact(A2, r.fact.id, "keep", { db, nowMs: T0 + 60_000 });
    if (!kept.ok || kept.decision !== "keep") throw new Error("not kept");
    const at = new Date(T0 + 60_000).toISOString();
    expect(kept.fact).toMatchObject({
      tenantId: "ten_A",
      kind: "channel",
      text: MARKETS.text,
      quote: MARKETS.quote,
      source: "chat",
      conversationId: kept.conversation!.id,
      heardAt: new Date(T0).toISOString(),
      confirmedAt: at,
    });
    expect(kept.fact.id).toMatch(/^bf_[a-f0-9]{16}$/);
    expect(kept.conversation).toMatchObject({ source: "chat", status: "ended", by: "usr_a1", startedAt: new Date(T0).toISOString(), confirmedAt: at, learned: null });
    expect(kept.conversation!.id).toMatch(/^oc_[a-f0-9]{32}$/);
    expect(kept.conversation!.turns).toEqual([
      { who: "vizzy", text: MARKETS.asked, atSec: 0 },
      { who: "member", text: MARKETS.quote, atSec: 0 },
      { who: "vizzy", text: SUGGESTION_WORDS.keptLine, atSec: 0 },
    ]);

    expect((await listBusinessFacts(A, { db: fake })).map((f) => f.id)).toEqual([kept.fact.id]);
    expect(await listConversations(A, { db: fake })).toEqual([
      expect.objectContaining({ id: kept.conversation!.id, source: "chat", turnCount: 3, waiting: false }),
    ]);
    const action = await getAgentAction(A, r.fact.id, { db: fake });
    expect(action).toMatchObject({ state: "acted", proposal: null, result: { factId: kept.fact.id, conversationId: kept.conversation!.id }, actedBy: { type: "member", id: "usr_a2" } });
    expect((await getTenantById("ten_A", fake))?.businessProfile?.rev).toBe(3);
    expect(await openFactSuggestions(A, { db: fake, nowMs: T0 + 60_000 })).toEqual([]);
    // Keeping it again changes nothing.
    expect(await decideBusinessFact(A2, r.fact.id, "keep", { db, nowMs: T0 + 70_000 })).toEqual({ ok: false, error: "already_decided" });
    expect(await listBusinessFacts(A, { db: fake })).toHaveLength(1);
  });

  it("keeps two lines when Vizzy asked nothing, and the fact alone when 20 conversations are kept", async () => {
    expect(keptChatTurns({ asked: "", quote: "We sell at markets." }).map((t) => t.who)).toEqual(["member", "vizzy"]);
    const db = brandDb();
    for (let i = 0; i < ONBOARDING_LIMITS.MAX_CONVERSATIONS; i += 1) {
      db.seed("onboarding_conversations", `oc_${String(i).padStart(32, "0")}`, { tenantId: "ten_A", source: "voice", status: "ended", startedAt: "2026-11-01T00:00:00.000Z", turns: [] });
    }
    const r = await suggested(db);
    const kept = await decideBusinessFact(A, r.fact.id, "keep", { db, nowMs: T0 + 1000 });
    expect(kept).toMatchObject({ ok: true, decision: "keep", conversation: null, fact: { conversationId: null } });
    expect((await getAgentAction(A, r.fact.id, { db }))?.result).toEqual({ factId: (kept as { fact: { id: string } }).fact.id, conversationId: null });
  });

  it("gives a brand with no profile one, so Vizzy reads what was kept", async () => {
    const db = brandDb({ profile: false });
    const r = await suggested(db);
    await decideBusinessFact(A, r.fact.id, "keep", { db, nowMs: T0 + 1000 });
    expect((await getTenantById("ten_A", db))?.businessProfile).toMatchObject({ status: "done", answers: {}, rev: 1 });
  });

  it("Remove declines it with its words cleared, and writes no fact", async () => {
    const db = brandDb();
    const r = await suggested(db);
    expect(await decideBusinessFact(A, r.fact.id, "remove", { db, nowMs: T0 + 1000 })).toEqual({ ok: true, decision: "remove" });
    expect(await getAgentAction(A, r.fact.id, { db })).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, proposal: null });
    expect(await listBusinessFacts(A, { db })).toEqual([]);
    expect(await decideBusinessFact(A, r.fact.id, "keep", { db, nowMs: T0 + 2000 })).toEqual({ ok: false, error: "already_decided" });
  });

  it("never finds another brand's suggestion, a bad id, or another kind of action", async () => {
    const db = brandDb();
    const r = await suggested(db);
    expect(await decideBusinessFact(B, r.fact.id, "keep", { db, nowMs: T0 })).toEqual({ ok: false, error: "not_found" });
    expect(await decideBusinessFact(A, "aa_nope", "keep", { db, nowMs: T0 })).toEqual({ ok: false, error: "not_found" });
    const other = await proposeAgentAction(
      A,
      {
        dedupeKey: "data_signal.suggest|x1",
        agent: "connector_signals",
        action: "data_signal.suggest",
        target: { type: "data_signal", id: "ds_1" },
        personId: null,
        proposal: { kind: "goal", text: "Not a fact", quote: "Not a fact suggestion at all." },
        basis: null,
        signals: [],
        review: null,
        requestedBy: { type: "system", id: "test" },
        expiresAt: new Date(T0 + DAY).toISOString(),
        at: new Date(T0).toISOString(),
      },
      { db },
    );
    expect(await decideBusinessFact(A, other.action.id, "keep", { db, nowMs: T0 })).toEqual({ ok: false, error: "not_found" });
    expect(await listBusinessFacts(A, { db })).toEqual([]);
    expect(await decideBusinessFact({ ...A, userId: undefined }, r.fact.id, "keep", { db, nowMs: T0 })).toEqual({ ok: false, error: "no_user" });
  });

  it("sets aside one that ran out of time instead of keeping it", async () => {
    const db = brandDb();
    const r = await suggested(db);
    expect(await decideBusinessFact(A, r.fact.id, "keep", { db, nowMs: T0 + 31 * DAY })).toEqual({ ok: false, error: "already_decided" });
    expect(await getAgentAction(A, r.fact.id as AgentActionId, { db })).toMatchObject({ state: "declined", declined: { reason: "expired" }, proposal: null });
    expect(await listBusinessFacts(A, { db })).toEqual([]);
  });

  it("refuses to keep past 40 facts", async () => {
    const db = brandDb();
    const r = await suggested(db);
    for (let i = 0; i < ONBOARDING_LIMITS.MAX_FACTS; i += 1) {
      db.seed("business_facts", `bf_${String(i).padStart(16, "0")}`, { tenantId: "ten_A", kind: "goal", text: `Goal ${i}`, quote: `Goal ${i} quote words`, createdAt: "2026-11-24T10:00:00.000Z" });
    }
    expect(await decideBusinessFact(A, r.fact.id, "keep", { db, nowMs: T0 + 1000 })).toEqual({ ok: false, error: "too_many_facts" });
    expect((await getAgentAction(A, r.fact.id, { db }))?.state).toBe("proposed");
  });
});

describe("in Review", () => {
  it("is one item per suggestion, opening About your business, in house style", async () => {
    const db = brandDb();
    const r = await suggested(db);
    const action = await getAgentAction(A, r.fact.id, { db });
    expect(businessFactReviewItem(action!)).toEqual({
      id: `aa:${r.fact.id}`,
      kind: "business_fact",
      title: "Vizzy heard something new about your business",
      detail: MARKETS.text,
      href: "/admin/account/settings#about",
      action: "Check",
    });
    for (const w of Object.values(SUGGESTION_WORDS)) {
      const text = typeof w === "function" ? w("25 Nov") : w;
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });
});
