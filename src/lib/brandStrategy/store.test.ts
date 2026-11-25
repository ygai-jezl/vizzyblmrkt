import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import { situationKey } from "@/lib/brandMap/keys";
import { brandStrategyDocId, BRAND_STRATEGY_LIMITS, competitorsOf, type StrategyClaim } from "@/lib/types/brandStrategy";
import {
  approveStrategy,
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
      const p = await saveProposal(A, proposal({ audiences: [`Audience ${i}`] }), { db, ...at(T0 + i * 1000) });
      rev = p.ok ? p.value.rev : rev;
      const ok = await approveStrategy(A, { baseRev: rev }, { db, ...at(T0 + i * 1000 + 500) });
      expect(ok.ok).toBe(true);
    }
    const doc = await readBrandStrategyDoc(A, { db });
    expect(doc?.approved?.audiences).toEqual(["Audience 6"]);
    expect(doc?.history.map((h) => h.audiences[0])).toEqual(["Audience 5", "Audience 4", "Audience 3", "Audience 2", "Audience 1"]);
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
    expect(list.map((c) => `${c.name}:${c.ticked}`)).toEqual(["Gamma:false", "Alpha:true"]);
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
