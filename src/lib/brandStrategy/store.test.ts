import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import { situationKey } from "@/lib/brandMap/keys";
import { brandStrategyDocId, BRAND_STRATEGY_LIMITS, competitorsOf, emptyStrategy, groupsOf, StrategySchema, type StrategyClaim } from "@/lib/types/brandStrategy";
import {
  approveStrategy,
  claimFinderRun,
  mergeFound,
  mergeProposal,
  syncFocusFlags,
  decideIsNot,
  deleteBrandStrategy,
  fullRunsInMonth,
  measureKeyOf,
  readBrandStrategy,
  readBrandStrategyDoc,
  saveFound,
  saveProposal,
  saveStrategyDraft,
  type ProposedStrategy,
} from "./store";

// Made-up brands and people.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", email: "admin@a.example.com", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "idtoken", userId: "usr_b", role: "admin" };
const T0 = Date.parse("2026-11-25T10:00:00.000Z");
const at = (ms: number) => ({ now: () => new Date(ms) });

const claim = (id: string, text: string, proof: StrategyClaim["proof"] = null): StrategyClaim => ({ id, side: "you", text, competitor: null, proof, proposed: text });

function proposal(over: Partial<ProposedStrategy> = {}): ProposedStrategy {
  return {
    focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa02", "sit_aaaaaa03"],
    audiences: ["Marketing teams", "Agencies"],
    claims: [claim("cl_aaaaaa01", "Tracks 8 AI engines", { kind: "product", url: "https://a.example.com/docs/engines", title: "Engines" }), claim("cl_aaaaaa02", "Cheapest for a solo founder")],
    isNotProposals: [{ text: "Not an SEO suite", why: "Rivals sell one", competitor: null, state: "proposed" }],
    goal: { text: "200 sign-ups from search by March", measure: "sign-ups", measureKey: null, from: "onboarding", setAt: "2026-11-25T10:00:00.000Z" },
    watched: [{ name: "Rivalco", site: "rivalco.example" }],
    sources: ["identity", "situations"],
    made: { promptId: "brand.strategy_propose", version: 1, model: "test-model" },
    ...over,
  };
}

async function seedSituations(db: FakeFirestore, ctx: TenantContext, ids: string[], focus: string[] = []) {
  const store = brandMapRecords(ctx, db);
  for (const [i, id] of ids.entries()) {
    const text = `Situation number ${i + 1}`;
    await store.create("sit", id, { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, focus: focus.includes(id), order: i, createdAt: "", updatedAt: "" });
  }
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the brand strategy's record", () => {
  it("keeps each brand's strategy to itself: another brand reads, edits, approves and deletes nothing of it", async () => {
    const db = new FakeFirestore();
    const made = await saveProposal(A, proposal(), { db, ...at(T0) });
    expect(made.ok).toBe(true);
    const rev = made.ok ? made.value.rev : 0;
    expect(await readBrandStrategyDoc(B, { db })).toBeNull();
    // A guessed id from the other brand is invisible.
    expect(await forTenant(B, db).brandStrategy.getById(brandStrategyDocId("ten_A"))).toBeNull();
    expect(await saveStrategyDraft(B, { baseRev: rev, audiences: ["Someone else"] }, { db })).toMatchObject({ ok: false, error: "no_draft" });
    expect(await approveStrategy(B, { baseRev: rev }, { db })).toMatchObject({ ok: false, error: "no_draft" });
    expect(await deleteBrandStrategy(B, { db })).toBe(false);
    const still = await readBrandStrategyDoc(A, { db });
    expect(still?.draft?.audiences).toEqual(["Marketing teams", "Agencies"]);
    expect(still?.tenantId).toBe("ten_A");
  });

  it("reads the approved strategy only, and nothing with the switch off", async () => {
    const db = new FakeFirestore();
    const made = await saveProposal(A, proposal(), { db, ...at(T0) });
    expect(await readBrandStrategy(A, { db })).toBeNull();
    await approveStrategy(A, { baseRev: made.ok ? made.value.rev : 0 }, { db, ...at(T0 + 1000) });
    const approved = await readBrandStrategy(A, { db });
    expect(approved).toMatchObject({ focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa02", "sit_aaaaaa03"], at: "2026-11-25T10:00:01.000Z", by: "admin@a.example.com" });
    expect(competitorsOf(approved!)).toEqual([expect.objectContaining({ name: "Rivalco", site: "rivalco.example", ticked: true, from: "watched", group: "most" })]);
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "false");
    expect(await readBrandStrategy(A, { db })).toBeNull();
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_ENABLED", "false");
    expect(await readBrandStrategy(A, { db })).toBeNull();
  });

  it("keeps the last 5 approved, newest first, and the draft as approved", async () => {
    const db = new FakeFirestore();
    let rev = 0;
    for (let i = 0; i < 7; i += 1) {
      const p = await saveProposal(A, proposal({ goal: { text: `Goal ${i}`, measure: "", measureKey: null, from: "vizzy", setAt: "" } }), { db, ...at(T0 + i * 1000) });
      rev = p.ok ? p.value.rev : rev;
      const ok = await approveStrategy(A, { baseRev: rev }, { db, ...at(T0 + i * 1000 + 500) });
      expect(ok.ok).toBe(true);
    }
    const doc = await readBrandStrategyDoc(A, { db });
    expect(doc?.approved?.goal?.text).toEqual("Goal 6");
    expect(doc?.history.map((h) => h.goal?.text)).toEqual(["Goal 5", "Goal 4", "Goal 3", "Goal 2", "Goal 1"]);
    expect(doc?.draft).toEqual(doc?.approved);
  });

  it("refuses an edit or approval from an older copy, with the record as it is now", async () => {
    const db = new FakeFirestore();
    const made = await saveProposal(A, proposal(), { db, ...at(T0) });
    const rev = made.ok ? made.value.rev : 0;
    const saved = await saveStrategyDraft(A, { baseRev: rev, audiences: ["Founders"] }, { db, ...at(T0 + 1000) });
    expect(saved).toMatchObject({ ok: true, value: { rev: rev + 1 } });
    expect(await saveStrategyDraft(A, { baseRev: rev, audiences: ["Late"] }, { db })).toMatchObject({ ok: false, status: 409, error: "strategy_changed", current: { rev: rev + 1 } });
    expect(await approveStrategy(A, { baseRev: rev }, { db })).toMatchObject({ ok: false, status: 409, error: "strategy_changed" });
  });

  it("keeps what a person decided as small entries, newest first: stars, ticks, claim edits, isNot and the goal", async () => {
    const db = new FakeFirestore();
    let doc = await saveProposal(A, proposal(), { db, ...at(T0) });
    const rev = () => (doc.ok ? doc.value.rev : 0);
    doc = await saveStrategyDraft(
      A,
      {
        baseRev: rev(),
        focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa04"],
        ticked: [{ name: "Rivalco", ticked: false }],
        claims: [{ id: "cl_aaaaaa01", side: "you", text: "Tracks 8 AI engines, Google AI Mode included" }, { side: "them", text: "Already in the suite teams pay for", competitor: "Rivalco" }],
        goal: { text: "300 sign-ups by March", measure: "Sends" },
      },
      { db, ...at(T0 + 1000) },
    );
    expect(doc.ok).toBe(true);
    const draft = doc.ok ? doc.value.draft! : null;
    // An edited claim keeps its proof; a new one is a gap.
    expect(draft?.claims[0]).toMatchObject({ text: "Tracks 8 AI engines, Google AI Mode included", proof: { kind: "product" }, proposed: "Tracks 8 AI engines" });
    expect(draft?.claims[1]).toMatchObject({ side: "them", competitor: "Rivalco", proof: null, proposed: null });
    expect(draft?.goal).toMatchObject({ text: "300 sign-ups by March", measure: "Sends", measureKey: "sends", from: "person" });
    const kinds = (doc.ok ? doc.value.decisions : []).map((d) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(["star_added", "star_removed", "competitor_unticked", "claim_edited", "claim_added", "claim_removed", "goal_set"]));
    const edited = (doc.ok ? doc.value.decisions : []).find((d) => d.kind === "claim_edited");
    expect(edited).toMatchObject({ before: "Tracks 8 AI engines", after: "Tracks 8 AI engines, Google AI Mode included", by: "admin@a.example.com" });

    doc = await decideIsNot(A, { baseRev: rev(), text: "not an seo suite", accept: true }, { db, ...at(T0 + 2000) });
    expect(doc.ok && doc.value.draft?.isNotProposals[0]?.state).toBe("accepted");
    expect(doc.ok && doc.value.decisions[0]).toMatchObject({ kind: "is_not_accepted", ref: "Not an SEO suite" });
    expect(await decideIsNot(A, { baseRev: rev(), text: "Never proposed", accept: false }, { db })).toMatchObject({ ok: false, status: 404 });

    doc = await approveStrategy(A, { baseRev: rev() }, { db, ...at(T0 + 3000) });
    const approval = (doc.ok ? doc.value.decisions : []).filter((d) => d.at === "2026-11-25T10:00:03.000Z").map((d) => `${d.kind}:${d.ref}`);
    expect(approval).toEqual(["approved:strategy", "star_kept:sit_aaaaaa01", "star_removed:sit_aaaaaa02", "star_removed:sit_aaaaaa03"]);
  });

  it("keeps at most 200 decisions, the newest", async () => {
    const db = new FakeFirestore();
    let doc = await saveProposal(A, proposal(), { db, ...at(T0) });
    for (let i = 0; i < 70; i += 1) {
      // Each save stars one and unstars one: 2 or more decisions.
      const ids = i % 2 ? ["sit_aaaaaa01", "sit_aaaaaa02"] : ["sit_aaaaaa03", "sit_aaaaaa04"];
      doc = await saveStrategyDraft(A, { baseRev: doc.ok ? doc.value.rev : 0, focusSituationIds: ids }, { db, ...at(T0 + (i + 1) * 1000) });
    }
    const decisions = doc.ok ? doc.value.decisions : [];
    expect(decisions).toHaveLength(BRAND_STRATEGY_LIMITS.decisions);
    expect(decisions[0]!.at > decisions[decisions.length - 1]!.at).toBe(true);
  });

  it("stars the approved focus situations on the brand map, and unstars the rest", async () => {
    const db = new FakeFirestore();
    await seedSituations(db, A, ["sit_aaaaaa01", "sit_aaaaaa02", "sit_aaaaaa03", "sit_aaaaaa09"], ["sit_aaaaaa09"]);
    await seedSituations(db, B, ["sit_bbbbbb01"], ["sit_bbbbbb01"]);
    const made = await saveProposal(A, proposal(), { db, ...at(T0) });
    await approveStrategy(A, { baseRev: made.ok ? made.value.rev : 0 }, { db, ...at(T0 + 1000) });
    const rows = await brandMapRecords(A, db).pageAll("sit");
    expect(Object.fromEntries(rows.map((r) => [r.id, r.focus]))).toEqual({ sit_aaaaaa01: true, sit_aaaaaa02: true, sit_aaaaaa03: true, sit_aaaaaa09: false });
    expect(rows.find((r) => r.id === "sit_aaaaaa01")?.rev).toBe(1);
    // The other brand's star is left alone.
    expect((await brandMapRecords(B, db).get("sit", "sit_bbbbbb01"))?.focus).toBe(true);
  });

  it("keeps a person's ticks and own competitors when the finder runs again, and counts full runs by month", async () => {
    const db = new FakeFirestore();
    const found = (names: string[]) => names.map((name) => ({ name, site: `${name.toLowerCase()}.example`, foundTimes: 2, evidence: [], ticked: false, from: "finder" as const, group: "most" as const }));
    let doc = await saveFound(A, { mode: "quick", found: found(["Alpha", "Beta"]) }, { db, ...at(T0) });
    doc = await saveStrategyDraft(A, { baseRev: doc.ok ? doc.value.rev : 0, ticked: [{ name: "Alpha", ticked: true }] }, { db, ...at(T0 + 1000) });
    doc = await saveFound(A, { mode: "full", found: found(["Gamma"]) }, { db, ...at(T0 + 2000) });
    const list = doc.ok ? competitorsOf(doc.value.draft!) : [];
    // What a person ticked comes first in its group.
    expect(list.map((c) => `${c.name}:${c.ticked}`)).toEqual(["Alpha:true", "Gamma:false"]);
    expect(doc.ok && doc.value.finder.quickAt).toBe("2026-11-25T10:00:00.000Z");
    doc = await saveFound(A, { mode: "quick", found: found(["Delta"]) }, { db, ...at(T0 + 3000) });
    // The quick run is remembered as the first one.
    expect(doc.ok && doc.value.finder.quickAt).toBe("2026-11-25T10:00:00.000Z");
    expect(fullRunsInMonth(doc.ok ? doc.value : null, new Date(T0))).toBe(1);
    expect(fullRunsInMonth(doc.ok ? doc.value : null, new Date("2026-12-02T00:00:00.000Z"))).toBe(0);
  });

  it("keeps a goal a person set when Vizzy proposes again, and reads a measure YouGrow knows", async () => {
    const db = new FakeFirestore();
    let doc = await saveProposal(A, proposal(), { db, ...at(T0) });
    doc = await saveStrategyDraft(A, { baseRev: doc.ok ? doc.value.rev : 0, goal: { text: "Our own goal", measure: "" } }, { db, ...at(T0 + 1000) });
    doc = await saveProposal(A, proposal(), { db, ...at(T0 + 2000) });
    expect(doc.ok && doc.value.draft?.goal?.text).toBe("Our own goal");
    expect(measureKeyOf("open rate")).toBe("openRate");
    expect(measureKeyOf("sign-ups")).toBeNull();
  });

  it("deletes the whole record", async () => {
    const db = new FakeFirestore();
    await saveProposal(A, proposal(), { db, ...at(T0) });
    expect(await deleteBrandStrategy(A, { db })).toBe(true);
    expect(await readBrandStrategyDoc(A, { db })).toBeNull();
    expect(await deleteBrandStrategy(A, { db })).toBe(false);
  });
});

describe("what a person decided stays, and runs and approvals hold", () => {
  const find = (name: string, over: Record<string, unknown> = {}) => ({ name, site: `${name.toLowerCase()}.example`, foundTimes: 1, evidence: [], ticked: false, from: "finder" as const, group: "most" as const, ...over });

  it("never lets new finds push out a competitor a person ticked or added, or one the brand watches", () => {
    const draft = StrategySchema.parse({
      ...emptyStrategy("", null),
      competitorGroups: groupsOf([find("Ticked", { ticked: true }), find("Watched", { from: "watched", ticked: true }), find("Added", { from: "person" }), find("Old")]),
    });
    const next = mergeFound(draft, Array.from({ length: 12 }, (_, i) => find(`New ${i}`)), "", null);
    const names = competitorsOf(next).map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(["Ticked", "Watched", "Added"]);
    // The finder's own finds fill at most 8 places; the old untouched find gave way.
    expect(names.filter((n) => n.startsWith("New"))).toHaveLength(BRAND_STRATEGY_LIMITS.competitorsPerGroup);
    expect(names).not.toContain("Old");
    // Ten watched competitors all stay in one group.
    const watched = groupsOf(Array.from({ length: 10 }, (_, i) => find(`W${i}`, { from: "watched" })).concat(Array.from({ length: 9 }, (_, i) => find(`F${i}`))));
    expect(watched[0]!.competitors.filter((c) => c.from === "watched")).toHaveLength(10);
  });

  it("keeps a Vizzy claim a person edited when Vizzy proposes again", () => {
    const draft = StrategySchema.parse({ ...emptyStrategy("", null), claims: [{ ...claim("cl_aaaaaa01", "Tracks 8 AI engines"), text: "Tracks 8 AI engines, AI Mode too" }, claim("cl_aaaaaa02", "Untouched claim")] });
    const next = mergeProposal(draft, proposal({ claims: [claim("cl_bbbbbb01", "A new claim")] }), "", null);
    expect(next.claims.map((c) => c.text)).toEqual(["Tracks 8 AI engines, AI Mode too", "A new claim"]);
  });

  it("keeps the stars and audiences a person set; Vizzy sets the stars only while they are as it proposed them, and says so", async () => {
    const db = new FakeFirestore();
    let doc = await saveProposal(A, proposal(), { db, ...at(T0) });
    doc = await saveStrategyDraft(A, { baseRev: doc.ok ? doc.value.rev : 0, focusSituationIds: ["sit_aaaaaa09"], audiences: ["Founders"] }, { db, ...at(T0 + 1000) });
    doc = await saveProposal(A, proposal({ focusSituationIds: ["sit_aaaaaa05", "sit_aaaaaa06", "sit_aaaaaa07"], audiences: ["From the map"] }), { db, ...at(T0 + 2000) });
    expect(doc.ok && doc.value.draft).toMatchObject({ focusSituationIds: ["sit_aaaaaa09"], proposedFocusIds: ["sit_aaaaaa05", "sit_aaaaaa06", "sit_aaaaaa07"], audiences: ["Founders"] });

    const db2 = new FakeFirestore();
    await saveProposal(A, proposal(), { db: db2, ...at(T0) });
    const again = await saveProposal(A, proposal({ focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa05", "sit_aaaaaa06"] }), { db: db2, ...at(T0 + 1000) });
    expect(again.ok && again.value.draft?.focusSituationIds).toEqual(["sit_aaaaaa01", "sit_aaaaaa05", "sit_aaaaaa06"]);
    const logged = (again.ok ? again.value.decisions : []).map((d) => `${d.kind}:${d.ref}:${d.by}`);
    expect(logged.sort()).toEqual(["star_added:sit_aaaaaa05:vizzy", "star_added:sit_aaaaaa06:vizzy", "star_removed:sit_aaaaaa02:vizzy", "star_removed:sit_aaaaaa03:vizzy"]);
  });

  it("refuses to approve fewer than 3 focus situations, or fewer than all when the map has less", async () => {
    const db = new FakeFirestore();
    await seedSituations(db, A, ["sit_aaaaaa01", "sit_aaaaaa02", "sit_aaaaaa03", "sit_aaaaaa04"]);
    let doc = await saveProposal(A, proposal({ focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa02", "sit_zzzzzz99"] }), { db, ...at(T0) });
    expect(await approveStrategy(A, { baseRev: doc.ok ? doc.value.rev : 0 }, { db })).toMatchObject({ ok: false, status: 400, error: "too_few_focus" });
    expect(await readBrandStrategy(A, { db })).toBeNull();
    const small = new FakeFirestore();
    await seedSituations(small, A, ["sit_aaaaaa01", "sit_aaaaaa02"]);
    doc = await saveProposal(A, proposal({ focusSituationIds: ["sit_aaaaaa01"] }), { db: small, ...at(T0) });
    expect(await approveStrategy(A, { baseRev: doc.ok ? doc.value.rev : 0 }, { db: small })).toMatchObject({ ok: false, error: "too_few_focus" });
    doc = await saveStrategyDraft(A, { baseRev: doc.ok ? doc.value.rev : 0, focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa02"] }, { db: small, ...at(T0 + 1000) });
    expect((await approveStrategy(A, { baseRev: doc.ok ? doc.value.rev : 0 }, { db: small })).ok).toBe(true);
  });

  it("says which stars didn't change on the brand map when the approval went through", async () => {
    const db = new FakeFirestore();
    await seedSituations(db, A, ["sit_aaaaaa01", "sit_aaaaaa02", "sit_aaaaaa03", "sit_aaaaaa09"], ["sit_aaaaaa09"]);
    const made = await saveProposal(A, proposal(), { db, ...at(T0) });
    // Every write after the approval itself fails.
    const real = db.runTransaction.bind(db);
    let n = 0;
    db.runTransaction = ((fn: Parameters<typeof real>[0]) => (++n > 1 ? Promise.reject(new Error("down")) : real(fn))) as typeof db.runTransaction;
    const r = await approveStrategy(A, { baseRev: made.ok ? made.value.rev : 0 }, { db, ...at(T0 + 1000) });
    expect(r.ok).toBe(true);
    expect(r.starsNotUpdated?.sort()).toEqual(["sit_aaaaaa01", "sit_aaaaaa02", "sit_aaaaaa03", "sit_aaaaaa09"]);
    db.runTransaction = real;
    expect(await syncFocusFlags(A, ["sit_aaaaaa01", "sit_aaaaaa02", "sit_aaaaaa03"], { db })).toEqual({ changed: 4, failed: [] });
  });

  it("takes a finder run's place in one transaction, so two at once can't both pass", async () => {
    const db = new FakeFirestore();
    const quick = await Promise.all([claimFinderRun(A, { mode: "quick", granted: false, limit: null }, { db }), claimFinderRun(A, { mode: "quick", granted: false, limit: null }, { db })]);
    expect(quick.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual(["finder_quick_used", "ok"]);
    const full = await Promise.all([1, 2, 3].map(() => claimFinderRun(A, { mode: "full", granted: true, limit: 2 }, { db, ...at(T0) })));
    expect(full.map((r) => (r.ok ? "ok" : r.error)).sort()).toEqual(["finder_monthly_limit", "ok", "ok"]);
  });
});
