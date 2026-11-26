import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { situationKey } from "@/lib/brandMap/keys";
import { readBrandMap, saveBrandMap } from "@/lib/brandMap/store";
import { approveFromRequest, isNotFromRequest, saveFromRequest, sameStrategy, strategyView } from "./adminApi";
import { readBrandStrategyDoc, saveProposal, type ProposedStrategy } from "./store";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", role: "admin" };
const MEMBER: TenantContext = { ...A, userId: "usr_m", role: "member" };
const T0 = Date.parse("2026-11-25T10:00:00.000Z");
const TENANT = { tenantName: "Acme", businessProfile: { status: "done", answers: { want: "waitlist" }, rev: 1, startedAt: "" } } as unknown as Tenant;

const PROPOSAL: ProposedStrategy = {
  focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa02"],
  audiences: ["Marketing teams"],
  claims: [],
  isNotProposals: [{ text: "Not an SEO suite", why: "", competitor: null, state: "proposed" }],
  goal: null,
  watched: [],
  sources: ["identity"],
  made: { promptId: "brand.strategy_propose", version: 1, model: "test-model" },
};

async function brand() {
  const db = new FakeFirestore();
  await saveBrandMap(A, { baseRev: 0, decided: { identity: { name: "Acme", statement: "AI visibility tracking", isNot: ["Not an agency"] } } }, { db, nowMs: T0 });
  const store = brandMapRecords(A, db);
  for (const [i, id] of ["sit_aaaaaa01", "sit_aaaaaa02"].entries()) {
    const text = `Situation ${i + 1}`;
    await store.create("sit", id, { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: i, counts: { questions: 5 - i, answered: 1 }, createdAt: "", updatedAt: "" });
  }
  db.seed("business_facts", "bf_aaaaaaaaaaaaaaaa", { tenantId: "ten_A", kind: "goal", text: "200 sign-ups by March", quote: "We want two hundred sign-ups", source: "voice", conversationId: null, heardAt: "", confirmedAt: "", createdAt: "2026-11-01T00:00:00.000Z" });
  const made = await saveProposal(A, PROPOSAL, { db, now: () => new Date(T0) });
  return { db, rev: made.ok ? made.value.rev : 0 };
}

const view = (db: FakeFirestore) => ({ db, now: () => new Date(T0), loadTenant: async () => TENANT });

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the Strategy tab's view", () => {
  it("shows the draft, its stars on the decided situations, and where the goal starts; the goals people told Vizzy to admins only", async () => {
    const { db } = await brand();
    const v = await strategyView(A, view(db));
    expect(v).toMatchObject({ state: "draft", approved: null, identity: { statement: "AI visibility tracking", isNot: ["Not an agency"] } });
    expect(v.situations.map((s) => `${s.id}:${s.focus}:${s.questions}`)).toEqual(["sit_aaaaaa01:true:5", "sit_aaaaaa02:true:4"]);
    expect(v.goalStart).toEqual({ want: "Test demand and a waitlist", goals: ["200 sign-ups by March"] });
    expect((await strategyView(MEMBER, view(db))).goalStart.goals).toEqual([]);
    expect(v.finder).toMatchObject({ on: false, granted: false });
  });

  it("refuses focus on a situation the brand doesn't have, and reads approved, then changed", async () => {
    const { db, rev } = await brand();
    const bad = await saveFromRequest(A, { baseRev: rev, focusSituationIds: ["sit_zzzzzz99"] }, view(db));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "unknown_situation" });
    const approved = await approveFromRequest(A, { baseRev: rev }, view(db));
    const body = (await approved.json()) as { strategy: { state: string; rev: number } };
    expect(body.strategy.state).toBe("approved");
    const edited = await saveFromRequest(A, { baseRev: body.strategy.rev, focusSituationIds: ["sit_aaaaaa02"] }, view(db));
    const after = (await edited.json()) as { strategy: { state: string; rev: number } };
    expect(after.strategy.state).toBe("changed");
    // One star of the two the brand has: refused, with the message the screen shows.
    const refused = await approveFromRequest(A, { baseRev: after.strategy.rev }, view(db));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "too_few_focus" });
  });

  it("checks the line is still waiting before anything changes, and leaves neither changed when the brand map refuses it", async () => {
    const { db, rev } = await brand();
    // The brand map refuses: a line that clashes with a term to avoid can't go in. Here: the map isn't readable.
    db.seed("brand_maps", "bm_ten_A", { tenantId: "ten_A", identity: "not a map" } as never);
    const refused = await isNotFromRequest(A, { baseRev: rev, text: "Not an SEO suite", accept: true }, view(db));
    expect(refused.status).toBe(409);
    const doc = await readBrandStrategyDoc(A, { db });
    expect(doc?.draft?.isNotProposals[0]?.state).toBe("proposed");
    expect(doc?.decisions.some((d) => d.kind === "is_not_accepted")).toBe(false);
    // Declined, then asked again: refused, and the brand map is never touched.
    const fresh = await brand();
    await isNotFromRequest(A, { baseRev: fresh.rev, text: "Not an SEO suite", accept: false }, view(fresh.db));
    const later = await readBrandStrategyDoc(A, { db: fresh.db });
    const again = await isNotFromRequest(A, { baseRev: later!.rev, text: "Not an SEO suite", accept: true }, view(fresh.db));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_decided" });
    const map = await readBrandMap(A, fresh.db);
    expect(map.state === "ok" && map.map.identity.isNot).toEqual(["Not an agency"]);
  });

  it("Add puts a proposed line in Who you are; No keeps it out; both keep the decision", async () => {
    const { db, rev } = await brand();
    const added = await isNotFromRequest(A, { baseRev: rev, text: "not an SEO suite", accept: true }, view(db));
    expect(added.status).toBe(200);
    const map = await readBrandMap(A, db);
    expect(map.state === "ok" && map.map.identity.isNot).toEqual(["Not an agency", "Not an SEO suite"]);
    const doc = await readBrandStrategyDoc(A, { db });
    expect(doc?.decisions[0]).toMatchObject({ kind: "is_not_accepted", ref: "Not an SEO suite" });
    expect((await isNotFromRequest(A, { baseRev: rev, text: "Not an SEO suite", accept: false }, view(db))).status).toBe(409);
    expect((await isNotFromRequest(A, { baseRev: doc!.rev, text: "Never proposed", accept: true }, view(db))).status).toBe(404);
  });

  it("tells a draft from the approved one by what it says, not when it was saved", () => {
    const s = { ...PROPOSAL, proposedFocusIds: [], competitorGroups: [], at: "a", by: "x" } as never;
    expect(sameStrategy(s, { ...(s as object), at: "b", by: "y" } as never)).toBe(true);
    expect(sameStrategy(s, null)).toBe(false);
  });
});
