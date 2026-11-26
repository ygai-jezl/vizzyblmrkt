import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiUsage } from "@/lib/agents/gemini";
import { questionKey, situationKey } from "@/lib/brandMap/keys";
import { saveBrandMap } from "@/lib/brandMap/store";
import { withDerivedFacts } from "@/lib/content/blog/pageRow";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { BrandMapPageFactsSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import type { BrandSignal } from "@/lib/types/brandSignal";
import { StrategySchema } from "@/lib/types/brandStrategy";
import type { Tenant } from "@/lib/types/tenant";
import { makeContentPlan, MAX_NEW_LOOKUPS, type MakeDeps } from "./make";
import { readContentStrategyDoc } from "./store";

// Made-up brand.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", email: "admin@a.example.com", role: "admin" };
const NOW = new Date("2026-11-26T10:00:00.000Z");
const usage = {} as AiUsage;

const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme", category: "AI visibility", statement: "Acme tracks how AI answers name your brand." },
  subjects: [
    {
      id: "sub_aaaaaa01",
      name: "Tracking",
      questions: [
        { id: "q_aaaaaa01", text: "What is AI search visibility tracking?", intent: "definition" },
        { id: "q_aaaaaa02", text: "What does AI visibility tracking mean?", intent: "definition" },
        { id: "q_aaaaaa03", text: "How much does AI visibility tracking cost?", intent: "pricing" },
      ],
    },
    {
      id: "sub_aaaaaa02",
      name: "Audits",
      questions: [
        { id: "q_bbbbbb01", text: "How do you run a GEO audit?", intent: "how_to" },
        { id: "q_bbbbbb02", text: "The best GEO audit tools", intent: "alternatives" },
      ],
    },
    {
      id: "sub_aaaaaa03",
      name: "Citations",
      questions: [
        { id: "q_cccccc01", text: "Why does Perplexity cite review sites?", intent: "other" },
        { id: "q_cccccc02", text: "Is there a free llms.txt checker?", intent: "other" },
      ],
    },
  ],
});

// A stub embedder: the two tracking definitions are one ask; everything else is its own.
const DIR: Record<string, number[]> = {
  "What is AI search visibility tracking?": [1, 0, 0, 0, 0, 0, 0],
  "What does AI visibility tracking mean?": [0.98, 0.2, 0, 0, 0, 0, 0],
  "How much does AI visibility tracking cost?": [0, 1, 0, 0, 0, 0, 0],
  "How do you run a GEO audit?": [0, 0, 1, 0, 0, 0, 0],
  "The best GEO audit tools": [0, 0, 0, 1, 0, 0, 0],
  "Why does Perplexity cite review sites?": [0, 0, 0, 0, 1, 0, 0],
  "Is there a free llms.txt checker?": [0, 0, 0, 0, 0, 1, 0],
};
const embed = vi.fn(async (items: Array<{ content: string }>) => items.map((i) => DIR[i.content] ?? [0, 0, 0, 0, 0, 0, 1]));

function row(id: string, over: Record<string, unknown>): BrandMapPage {
  const facts = withDerivedFacts(BrandMapPageFactsSchema.parse({ kind: "article", workspaceId: "ws1", planId: id.slice(2), title: id, state: "live", liveAt: "2026-11-01T00:00:00.000Z", ...over }));
  return { ...facts, id, tenantId: "ten_A", fingerprint: `f_${id}`, updatedAt: "" };
}

const tenant = { id: "ten_A", autopilot: { mode: "draft", perWeek: 2 } } as unknown as Tenant;

function deps(db: FakeFirestore, over: Partial<MakeDeps> = {}): MakeDeps {
  return {
    db,
    now: () => NOW,
    loadTenant: async () => tenant,
    embed,
    modelReady: () => true,
    usage,
    generate: vi.fn(async () =>
      JSON.stringify({
        pillars: [
          { name: "Measure AI visibility", about: "What tracking is and costs", slots: ["S1", "S2"], hub: "S1" },
          { name: "Run an audit", slots: ["S3", "S4"] },
          { name: "Get cited", slots: ["S5", "S6"] },
        ],
        titles: [{ slot: "S1", title: "AI visibility tracking, explained" }],
      }),
    ),
    strategy: async () => null,
    searchPlanning: async () => null,
    coverage: async () => null,
    due: async () => [],
    repeats: async () => [],
    pages: async () => [],
    ...over,
  };
}

async function seedMap(db: FakeFirestore) {
  await saveBrandMap(A, { baseRev: 0, decided: DECIDED }, { db, nowMs: NOW.getTime() - 86_400_000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
  vi.stubEnv("CONTENT_STRATEGY_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("Make the plan", () => {
  it("merges the questions by meaning, names the pillars in one call, scores and orders the roadmap, and saves the draft", async () => {
    const db = new FakeFirestore();
    await seedMap(db);
    const d = deps(db);
    const r = await makeContentPlan(A, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = r.doc.draft!;
    expect(d.generate).toHaveBeenCalledTimes(1);
    expect(plan.slots.map((s) => s.questionIds)).toEqual([["q_aaaaaa01", "q_aaaaaa02"], ["q_aaaaaa03"], ["q_bbbbbb01"], ["q_bbbbbb02"], ["q_cccccc01"], ["q_cccccc02"]]);
    expect(plan.slots[0]).toMatchObject({ title: "AI visibility tracking, explained", stage: "learn", kind: "guide", hub: true });
    expect(plan.slots[1]).toMatchObject({ stage: "choose" });
    expect(plan.slots[3]).toMatchObject({ stage: "consider", kind: "list" });
    expect(plan.slots[5]).toMatchObject({ kind: "tool" });
    expect(plan.pillars.map((p) => p.name)).toEqual(["Measure AI visibility", "Run an audit", "Get cited"]);
    expect(plan.made).toMatchObject({ promptId: "content.strategy_plan" });
    // 12 weeks at the autopilot's 2 a week, at most one entry per slot, and never the tool page.
    expect(plan.rules).toMatchObject({ perWeek: 2, roadmapShare: 0.75, refreshShare: 0.33 });
    // The first block's focus pillar comes first, its hub before anything else.
    const first = plan.pillars.find((p) => p.id === plan.blocks[0]!.pillarIds[0])!;
    expect(first.hub?.kind).toBe("slot");
    expect(plan.roadmap[0]).toEqual({ week: "2026-W48", slotId: first.hub?.kind === "slot" ? first.hub.slotId : "", action: "write" });
    expect(plan.pillars[0]!.hub).toEqual({ kind: "slot", slotId: plan.slots[0]!.id });
    expect(new Set(plan.roadmap.map((e) => e.slotId)).size).toBe(plan.roadmap.length);
    expect(plan.roadmap.some((e) => e.slotId === plan.slots[5]!.id)).toBe(false);
    expect(plan.stageMix).toEqual({ learn: 71, consider: 14, choose: 14 });
    expect(plan.sources).toEqual(expect.arrayContaining(["brand_map", "meaning", "autopilot"]));
    expect(r.notes).toMatchObject({ byMeaning: true, slots: 6, lookupsAsked: 0 });
    expect((await readContentStrategyDoc(A, { db }))?.draft?.slots).toHaveLength(6);
  });

  it("finds the questions on the approved strategy's focus situations, and scores their fit", async () => {
    const db = new FakeFirestore();
    await seedMap(db);
    const store = brandMapRecords(A, db);
    const text = "A client asks what an audit costs";
    await store.create("sit", "sit_focus0001", { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: 0, createdAt: "", updatedAt: "" });
    await store.create("q", "q_bbbbbb01", { status: "decided", from: "person", subjectId: "sub_aaaaaa02", text: "How do you run a GEO audit?", textKey: questionKey("How do you run a GEO audit?"), situationIds: ["sit_focus0001"], rev: 0, createdAt: "", updatedAt: "" });
    const strategy = StrategySchema.parse({ focusSituationIds: ["sit_focus0001"], at: "2026-11-25T10:00:00.000Z" });
    const r = await makeContentPlan(A, deps(db, { strategy: async () => strategy }));
    const audit = r.ok ? r.doc.draft!.slots.find((s) => s.questionIds[0] === "q_bbbbbb01") : null;
    expect(audit).toMatchObject({ facts: { focus: 1 }, scores: { fit: 100 } });
    expect(r.ok && r.doc.draft!.sources).toContain("brand_strategy");
  });

  it("marks what live articles cover, combines Next up's repeats, and refreshes what is due", async () => {
    const db = new FakeFirestore();
    await seedMap(db);
    const pages = [row("p_plan1", { primaryRef: "q_aaaaaa01" }), row("p_plan2", { primaryRef: "q_bbbbbb01" }), row("p_plan3", { primaryQuestion: "AI visibility tracking, again" })];
    const repeats = [{ question: "What is AI search visibility tracking?", pages: [{ title: "a", url: null, planId: "plan1", workspaceId: "ws1" }, { title: "b", url: null, planId: "plan3", workspaceId: "ws1" }], sim: 0.95 }];
    const due = [{ planId: "plan2", workspaceId: "ws1", title: "Audits", url: "https://a.example.com/audit", state: "due" as const, reasons: [], dueAt: "", clockDays: 30 as const, subjectId: null }];
    const r = await makeContentPlan(A, deps(db, { pages: async () => pages, repeats: async () => repeats, due: async () => due }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = r.doc.draft!;
    expect(plan.slots[0]).toMatchObject({ coveredBy: ["p_plan1", "p_plan3"], kind: "combine" });
    expect(plan.slots[2]).toMatchObject({ coveredBy: ["p_plan2"], kind: "refresh" });
    const fixes = plan.roadmap.filter((e) => e.action !== "write");
    expect(fixes.map((e) => [e.action, e.slotId])).toEqual([
      ["combine", plan.slots[0]!.id],
      ["refresh", plan.slots[2]!.id],
    ]);
    expect(plan.sources).toEqual(expect.arrayContaining(["coverage", "repeats", "freshness"]));
  });

  it("checks merged slots against Google: uses fresh lookups, and asks for a few new ones under the cap", async () => {
    const db = new FakeFirestore();
    await seedMap(db);
    const sig = (query: string, urls: string[]): BrandSignal =>
      ({ id: `sig_${query.length}`, about: { query }, status: "ready", readyAt: "2026-11-20T00:00:00.000Z", numbers: { peopleAlsoAsk: 4 }, results: { top: urls.map((url, i) => ({ url, position: i + 1, domain: "", title: "" })) } }) as unknown as BrandSignal;
    const signals = [sig("What is AI search visibility tracking?", ["https://a.test/1", "https://a.test/2", "https://a.test/9"]), sig("What does AI visibility tracking mean?", ["https://b.test/1", "https://b.test/2"])];
    const lookUp = vi.fn(async () => ({ ok: true as const, signal: {} as BrandSignal, reused: false }));
    const r = await makeContentPlan(A, deps(db, { signals: async () => signals, lookUp }));
    const plan = r.ok ? r.doc.draft! : null;
    // They share fewer than 3 of the top 10, so Google splits them.
    expect(plan?.slots.slice(0, 2).map((s) => [s.questionIds, s.facts.serp])).toEqual([
      [["q_aaaaaa01"], "split"],
      [["q_aaaaaa02"], "split"],
    ]);
    expect(plan?.slots[0]!.facts.paa).toBe(4);
    expect(lookUp).not.toHaveBeenCalled();
    expect(MAX_NEW_LOOKUPS).toBe(6);

    // With no lookups yet, it asks for the merged slot's top questions (purpose content_strategy).
    const db2 = new FakeFirestore();
    await seedMap(db2);
    const r2 = await makeContentPlan(A, deps(db2, { signals: async () => [], lookUp }));
    expect(lookUp).toHaveBeenCalledTimes(2);
    expect(lookUp).toHaveBeenCalledWith(A, expect.objectContaining({ questionId: "q_aaaaaa01", purpose: "content_strategy" }));
    expect(r2.ok && r2.notes.lookupsAsked).toBe(2);
  });

  it("groups by the same words only when the embedding fails, and falls back to the subjects with no model", async () => {
    const db = new FakeFirestore();
    await seedMap(db);
    const generate = vi.fn();
    const r = await makeContentPlan(A, deps(db, { embed: vi.fn(async (items: unknown[]) => items.map(() => null)), modelReady: () => false, generate }));
    expect(generate).not.toHaveBeenCalled();
    expect(r.ok && r.doc.draft!.slots).toHaveLength(7);
    expect(r.ok && r.doc.draft!.pillars.map((p) => [p.name, p.from])).toEqual([
      ["Tracking", "subjects"],
      ["Audits", "subjects"],
      ["Citations", "subjects"],
    ]);
    expect(r.ok && r.doc.draft!.made).toBeNull();
    expect(r.ok && r.notes.byMeaning).toBe(false);
  });

  it("leaves out of the roadmap a slot whose question a person skipped lately", async () => {
    const db = new FakeFirestore();
    await seedMap(db);
    db.seed("autopilot_learned", "lrn_1", { tenantId: "ten_A", kind: "skipped_pick", text: "x", reason: "", questionId: "q_bbbbbb01", from: "person", at: "2026-11-20T00:00:00.000Z", by: null } as never);
    const r = await makeContentPlan(A, deps(db));
    const plan = r.ok ? r.doc.draft! : null;
    const audit = plan?.slots.find((s) => s.questionIds[0] === "q_bbbbbb01");
    expect(plan?.roadmap.some((e) => e.slotId === audit?.id)).toBe(false);
  });

  it("refuses with no brand map, or no decided questions", async () => {
    expect(await makeContentPlan(A, deps(new FakeFirestore()))).toMatchObject({ ok: false, status: 409, error: "no_brand_map" });
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: BrandMapDecidedSchema.parse({ identity: { name: "Acme" } }) }, { db });
    expect(await makeContentPlan(A, deps(db))).toMatchObject({ ok: false, error: "nothing_to_plan" });
  });
});
