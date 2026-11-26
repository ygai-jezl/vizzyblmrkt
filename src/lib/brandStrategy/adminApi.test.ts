import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { situationKey } from "@/lib/brandMap/keys";
import { readBrandMap, saveBrandMap } from "@/lib/brandMap/store";
import { monitorCompetitor, updateCompetitor } from "@/lib/competitors/store";
import { approveFromRequest, isNotFromRequest, notCompetitorFromRequest, saveFromRequest, sameStrategy, strategyView } from "./adminApi";
import { readBrandStrategyDoc, saveFound, saveProposal, type ProposedStrategy } from "./store";

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
    // Joined to Competitors, the list is live: a competitor found or watched since never counts as a change.
    const found = { ...(s as object), competitorGroups: [{ kind: "most", competitors: [{ name: "Rivalco" }] }], ungrouped: [{ name: "Newco" }] } as never;
    expect(sameStrategy(s, found)).toBe(false);
    expect(sameStrategy(s, found, true)).toBe(true);
    expect(sameStrategy(s, { ...(found as object), audiences: ["Someone else"] } as never, true)).toBe(false);
  });

  it("off, lists only what the strategy holds, as before", async () => {
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    const { db } = await brand();
    await monitorCompetitor(A, { website: "rivalco.example", name: "Rivalco" }, { db });
    const v = await strategyView(A, view(db));
    expect(v.joined).toBe(false);
    expect(v.competitors).toEqual([]);
  });
});

describe("the Strategy tab joined to Competitors", () => {
  beforeEach(() => {
    vi.stubEnv("COMPETITORS_ENABLED", "true");
    vi.stubEnv("STRATEGY_COMPETITORS_ENABLED", "true");
  });
  const find = (name: string) => ({ name, site: `${name.toLowerCase()}.example`, foundTimes: 1, evidence: [], ticked: false, from: "finder" as const, group: "big" as const });

  it("lists the watched competitors at once, before any Propose, then the finder's suggestions", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: { identity: { name: "Acme", statement: "AI visibility tracking" } } }, { db, nowMs: T0 });
    const watched = await monitorCompetitor(A, { website: "rivalco.example", name: "Rivalco" }, { db });
    await monitorCompetitor({ ...A, tenantId: "ten_B" }, { website: "theirs.example", name: "Theirs" }, { db });
    let v = await strategyView(A, view(db));
    expect(v).toMatchObject({ joined: true, state: "none" });
    expect(v.competitors.map((c) => [c.name, c.group, c.monitored])).toEqual([["Rivalco", null, true]]);
    // Grouped on Brand › Competitors: the tab shows it, and nothing about the strategy moved.
    await updateCompetitor(A, watched.ok ? watched.value.competitor.id : "", { group: "most" }, { db });
    await saveFound(A, { mode: "quick", found: [find("Alpha"), find("Rivalco")] }, { db, now: () => new Date(T0) });
    v = await strategyView(A, view(db));
    expect(v.competitors.map((c) => [c.name, c.group, c.monitored])).toEqual([
      ["Rivalco", "most", true],
      ["Alpha", "big", false],
    ]);
  });

  it("Not a competitor: refuses input it can't read, then takes the suggestion off for good", async () => {
    const { db } = await brand();
    await saveFound(A, { mode: "quick", found: [find("Alpha")] }, { db, now: () => new Date(T0) });
    for (const bad of [null, { name: "" }, { name: "Alpha", site: "alpha.example", tenantId: "ten_B" }, { name: "Two\nlines".repeat(20) }]) {
      const r = await notCompetitorFromRequest(A, bad, view(db));
      expect(r.status).toBe(400);
    }
    const r = await notCompetitorFromRequest(A, { name: "Alpha", site: "alpha.example" }, view(db));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { strategy: { competitors: Array<{ name: string }> } };
    expect(body.strategy.competitors).toEqual([]);
    expect((await notCompetitorFromRequest(A, { name: "Alpha", site: null }, view(db))).status).toBe(404);
  });

  it("approving keeps the live list, and a competitor watched after doesn't mark it changed", async () => {
    const { db, rev } = await brand();
    await monitorCompetitor(A, { website: "rivalco.example", name: "Rivalco", group: "most" }, { db });
    const approved = (await (await approveFromRequest(A, { baseRev: rev }, view(db))).json()) as { strategy: { state: string } };
    expect(approved.strategy.state).toBe("approved");
    const doc = await readBrandStrategyDoc(A, { db });
    expect(doc?.approved?.competitorGroups.map((g) => g.competitors.map((c) => c.name))).toEqual([["Rivalco"]]);
    await monitorCompetitor(A, { website: "newco.example", name: "Newco" }, { db });
    const v = await strategyView(A, view(db));
    expect(v.state).toBe("approved");
    expect(v.competitors.map((c) => c.name)).toEqual(["Rivalco", "Newco"]);
  });

  it("approves nothing when the competitors can't be read, and says so", async () => {
    const { db, rev } = await brand();
    await monitorCompetitor(A, { website: "rivalco.example", name: "Rivalco" }, { db });
    await saveFound(A, { mode: "quick", found: [find("Alpha")] }, { db, now: () => new Date(T0) });
    const before = await readBrandStrategyDoc(A, { db });
    const real = db.collection.bind(db);
    db.collection = ((name: string) => {
      const c = real(name);
      const down = () => {
        throw new Error("down");
      };
      return name === "competitors" ? { ...c, where: down, limit: down, get: down } : c;
    }) as typeof db.collection;
    const r = await approveFromRequest(A, { baseRev: before!.rev }, view(db));
    db.collection = real;
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "competitors_unreadable" });
    const after = await readBrandStrategyDoc(A, { db });
    expect(after?.approved).toBeNull();
    expect(after?.rev).toBe(before!.rev);
    expect(after?.decisions.some((d) => d.kind === "competitor_left_out")).toBe(false);
    expect(rev).toBeGreaterThan(0);
  });

  it("shows the draft's list as it is, with ticks, to a brand without Competitors", async () => {
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitors");
    const { db } = await brand();
    await saveFound(A, { mode: "quick", found: [find("Alpha")] }, { db, now: () => new Date(T0) });
    const v = await strategyView(A, view(db));
    expect(v).toMatchObject({ joined: true, canMonitor: false });
    expect(v.competitors.map((c) => [c.name, c.monitored, c.id])).toEqual([["Alpha", false, null]]);
  });
});
