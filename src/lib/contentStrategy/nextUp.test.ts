import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skipPick } from "@/lib/autopilot/adminApi";
import { addLearned, learnedLine } from "@/lib/autopilot/learned";
import { pickStep } from "@/lib/autopilot/draftSteps";
import { saveBrandMap } from "@/lib/brandMap/store";
import { withDerivedFacts } from "@/lib/content/blog/pageRow";
import type { Candidate } from "@/lib/nextUp/candidates";
import { pickNextUp, readNextUp, type PickDeps } from "@/lib/nextUp/pick";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { AutopilotRun, NextUpPick } from "@/lib/types/autopilot";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { BrandMapPageFactsSchema } from "@/lib/types/brandMapPage";
import { ContentPlanSchema, type ContentPlan, type PickSlot } from "@/lib/types/contentStrategy";
import { freePicksOf, mixRoadmap, planForNextUp, roadmapCandidates, skippedSlotQuestions, slotQuestionsFor } from "./nextUp";
import { approvePlan, saveMadePlan } from "./store";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const SYSTEM: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = new Date("2026-11-26T12:00:00.000Z");

const slotOf = (id: string): PickSlot => ({ id, title: `Slot ${id}`, pillar: "Get cited", kind: "guide", stage: "learn", action: "write", week: "2026-W48" });
const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  questionId: id,
  question: `Question ${id}?`,
  subjectId: "sub_aaaaaaaa",
  subjectName: "Share of voice",
  answered: 1,
  total: 4,
  lastArticleAt: null,
  focus: false,
  ...over,
});
const roadmapCand = (n: number) => cand(`q_rrrrrr0${n}`, { slot: slotOf(`slt_rrrrrr0${n}`) });
const freeCand = (n: number) => cand(`q_ffffff0${n}`);

const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme" },
  subjects: [
    {
      id: "sub_aaaaaa01",
      name: "Tracking",
      questions: [
        { id: "q_aaaaaa01", text: "What is AI visibility tracking?", intent: "definition" },
        { id: "q_aaaaaa02", text: "What does AI visibility tracking mean?", intent: "definition" },
        { id: "q_aaaaaa03", text: "How much does tracking cost?", intent: "pricing" },
        { id: "q_aaaaaa04", text: "How do you audit for AI search?", intent: "how_to" },
      ],
    },
  ],
});
const scores = { fit: 0, demand: 0, gap: 0, depth: 0, balance: 0, total: 10 };
const PLAN: ContentPlan = ContentPlanSchema.parse({
  slots: [
    { id: "slt_aaaaaa01", title: "AI visibility tracking, explained", questionIds: ["q_aaaaaa01", "q_aaaaaa02"], subjectIds: ["sub_aaaaaa01"], kind: "combine", pillarId: "pil_aaaaaa01", coveredBy: ["p_plan1", "p_plan2"], scores },
    { id: "slt_aaaaaa02", title: "How much does tracking cost?", questionIds: ["q_aaaaaa03"], subjectIds: ["sub_aaaaaa01"], stage: "choose", pillarId: "pil_aaaaaa01", scores },
    { id: "slt_aaaaaa03", title: "How do you audit for AI search?", questionIds: ["q_aaaaaa04"], subjectIds: ["sub_aaaaaa01"], kind: "refresh", pillarId: "pil_aaaaaa01", coveredBy: ["p_plan3"], scores },
  ],
  pillars: [{ id: "pil_aaaaaa01", name: "Measure AI visibility" }],
  roadmap: [
    { week: "2026-W48", slotId: "slt_aaaaaa01", action: "combine" },
    { week: "2026-W48", slotId: "slt_aaaaaa02", action: "write" },
    { week: "2026-W49", slotId: "slt_aaaaaa03", action: "refresh" },
  ],
  at: "2026-11-26T09:00:00.000Z",
});

function page(id: string, over: Record<string, unknown>) {
  const facts = withDerivedFacts(BrandMapPageFactsSchema.parse({ kind: "article", workspaceId: "ws1", planId: id.slice(2), title: id, state: "live", url: `https://acme.example/${id}`, liveAt: "2026-11-01T00:00:00.000Z", ...over }));
  return { ...facts, id, tenantId: "ten_A", fingerprint: `f_${id}`, updatedAt: "" };
}

async function seeded() {
  const db = new FakeFirestore();
  await saveBrandMap(A, { baseRev: 0, decided: DECIDED }, { db, nowMs: NOW.getTime() });
  db.seed("brand_map_pages", "p_plan1", page("p_plan1", { primaryRef: "q_aaaaaa01", title: "What Is AI Search Visibility Tracking" }) as never);
  db.seed("brand_map_pages", "p_plan2", page("p_plan2", { primaryRef: "q_aaaaaa02", title: "AI visibility tracking, explained" }) as never);
  db.seed("brand_map_pages", "p_plan3", page("p_plan3", { primaryQuestion: "Running an audit", title: "Running an audit" }) as never);
  return db;
}

const SWITCHES = ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BRAND_MAP_NEXT_UP_ENABLED", "BRAND_STRATEGY_ENABLED", "CONTENT_STRATEGY_ENABLED", "CONTENT_STRATEGY_NEXT_UP_ENABLED"];
beforeEach(() => {
  for (const s of SWITCHES) vi.stubEnv(s, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("3 of every 4 from the roadmap", () => {
  it("mixes three roadmap candidates to one free, each once, the rest from whichever lasts", () => {
    const mixed = mixRoadmap([1, 2, 3, 4, 5, 6].map(roadmapCand), [1, 2, 3, 4].map(freeCand), 0.75, 10);
    expect(mixed.map((c) => (c.slot ? "R" : "F")).join("")).toBe("RRRFRRRFFF");
    expect(mixRoadmap([roadmapCand(1)], [freeCand(1), roadmapCand(1), freeCand(2)], 0.75, 10).map((c) => c.questionId)).toEqual(["q_rrrrrr01", "q_ffffff01", "q_ffffff02"]);
    expect(freePicksOf(3, 0.75)).toBe(1);
  });

  it("reads the approved plan only with both switches on", async () => {
    const db = new FakeFirestore();
    const made = await saveMadePlan(A, PLAN, { db });
    await approvePlan(A, { baseRev: made.ok ? made.value.rev : 0 }, { db });
    expect((await planForNextUp(A, { db }))?.roadmap).toHaveLength(3);
    vi.stubEnv("CONTENT_STRATEGY_NEXT_UP_ENABLED", "false");
    expect(await planForNextUp(A, { db })).toBeNull();
    vi.stubEnv("CONTENT_STRATEGY_NEXT_UP_ENABLED", "true");
    vi.stubEnv("CONTENT_STRATEGY_ENABLED", "false");
    expect(await planForNextUp(A, { db })).toBeNull();
  });
});

describe("the roadmap's next open entries as candidates", () => {
  it("offers a combine of the two live articles, the slot's first open question, and a refresh as an addition to its live article", async () => {
    const db = await seeded();
    const out = await roadmapCandidates(A, PLAN, { exclude: new Set(), refreshes: [] }, { db });
    expect(out.map((c) => c.questionId)).toEqual(["combine:q_aaaaaa01", "q_aaaaaa03", "q_aaaaaa04"]);
    expect(out[0]).toMatchObject({ subjectName: "two live articles", slot: { action: "combine", pillar: "Measure AI visibility" } });
    expect(out[0]!.combine?.pages.map((p) => p.title)).toEqual(["What Is AI Search Visibility Tracking", "AI visibility tracking, explained"]);
    expect(out[1]).toMatchObject({ question: "How much does tracking cost?", subjectName: "Tracking", slot: { id: "slt_aaaaaa02", stage: "choose", action: "write" } });
    expect(out[2]!.closeTo).toMatchObject({ planId: "plan3", title: "Running an audit" });
  });

  it("skips the whole slot when any of its picks was skipped: never offering it again through its next question", async () => {
    const db = await seeded();
    const two = ContentPlanSchema.parse({ ...PLAN, slots: [{ id: "slt_cccccc01", title: "Costs and audits", questionIds: ["q_aaaaaa03", "q_aaaaaa04"], subjectIds: ["sub_aaaaaa01"], scores }], roadmap: [{ week: "2026-W48", slotId: "slt_cccccc01", action: "write" }] });
    expect((await roadmapCandidates(A, two, { exclude: new Set(), refreshes: [] }, { db })).map((c) => c.questionId)).toEqual(["q_aaaaaa03"]);
    expect(await roadmapCandidates(A, two, { exclude: new Set(["q_aaaaaa03"]), refreshes: [] }, { db })).toEqual([]);
    expect([...skippedSlotQuestions(two, new Set(["q_aaaaaa03"]))]).toEqual(["q_aaaaaa03", "q_aaaaaa04"]);
  });

  it("never offers a refresh someone skipped as an addition to its live article instead", async () => {
    const db = await seeded();
    const out = await roadmapCandidates(A, PLAN, { exclude: new Set(["refresh:plan3"]), refreshes: [] }, { db });
    expect(out.map((c) => c.questionId)).toEqual(["combine:q_aaaaaa01", "q_aaaaaa03"]);
  });

  it("uses the freshness watch's candidate for a due article, and passes over what was skipped", async () => {
    const db = await seeded();
    const due = cand("refresh:plan3", { refresh: { planId: "plan3", workspaceId: "ws1", reasons: [] }, subjectName: "a live article" });
    const out = await roadmapCandidates(A, PLAN, { exclude: new Set(["combine:q_aaaaaa01", "q_aaaaaa03"]), refreshes: [due] }, { db });
    expect(out.map((c) => [c.questionId, c.slot?.id])).toEqual([["refresh:plan3", "slt_aaaaaa03"]]);
  });
});

describe("Next up with an approved plan", () => {
  const free = [1, 2, 3, 4].map(freeCand);
  const roadmap = [1, 2, 3, 4, 5, 6].map(roadmapCand);
  async function setup(over: Partial<PickDeps> = {}): Promise<PickDeps & { db: FakeFirestore }> {
    const db = await seeded();
    return {
      now: () => NOW,
      loadTenant: async () => ({ id: "ten_A" }) as never,
      candidates: async () => free,
      search: async () => ({ ok: false, error: "unavailable" }) as never,
      flags: async () => null,
      notOnMap: async () => [],
      competitorNames: async () => [],
      searchPlanning: async () => null,
      refreshCandidates: async () => [],
      strategy: async () => null,
      configured: () => true,
      ...over,
      db,
    };
  }

  it("takes 3 of every 4 candidates from the roadmap, names each slot for the model, and lets one pick in three be free", async () => {
    let prompt = "";
    const d = await setup({
      contentPlan: async () => PLAN,
      roadmap: async () => roadmap,
      generate: vi.fn(async (p: string) => {
        prompt = p;
        // Two free picks asked for: only one is kept.
        return JSON.stringify({ picks: [{ n: 4, because: "Nobody answers it yet.", uses: ["4.1"] }, { n: 8, because: "Also open.", uses: [] }, { n: 1, because: "It fills Get cited.", uses: ["1.2"] }] });
      }),
    });
    const r = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(r.ok).toBe(true);
    const heads = prompt.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(heads.slice(0, 8).map((l) => (l.includes("PLAN") ? "R" : "F")).join("")).toBe("RRRFRRRF");
    expect(prompt).toContain('Content plan (approved by the brand): the slot "Slot slt_rrrrrr01" in the pillar "Get cited", a learn stage article, planned for week 2026-W48 to write it as a guide.');
    expect(prompt).toContain("choose at least 2 of your three from them");
    const picks = r.ok ? r.doc.picks : [];
    expect(picks.map((p) => p.questionId)).toEqual(["q_ffffff01", "q_rrrrrr01", "q_rrrrrr02"]);
    expect(picks.filter((p) => p.slot)).toHaveLength(2);
    expect(picks[1]!.slot).toMatchObject({ id: "slt_rrrrrr01", pillar: "Get cited" });
    expect(picks[1]!.chips.map((c) => c.label)).toEqual(["Content plan"]);
  });

  it("leaves a skipped slot out of the free picks too", async () => {
    const two = ContentPlanSchema.parse({ ...PLAN, slots: [{ id: "slt_cccccc01", title: "Costs and audits", questionIds: ["q_aaaaaa03", "q_aaaaaa04"], subjectIds: ["sub_aaaaaa01"], scores }], roadmap: [{ week: "2026-W48", slotId: "slt_cccccc01", action: "write" }] });
    const d = await setup({ contentPlan: async () => two, candidates: async () => [cand("q_aaaaaa04"), ...free], generate: vi.fn(async () => JSON.stringify({ picks: [] })) });
    await addLearned(A, { kind: "skipped_pick", text: "How much does tracking cost?", questionId: "q_aaaaaa03", from: "person" }, { db: d.db, now: () => NOW });
    const r = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(r.ok && r.doc.picks.map((p) => p.questionId)).toEqual(["q_ffffff01", "q_ffffff02", "q_ffffff03"]);
  });

  it("picks exactly as before without an approved plan", async () => {
    let prompt = "";
    const d = await setup({ contentPlan: async () => null, generate: vi.fn(async (p: string) => ((prompt = p), JSON.stringify({ picks: [] }))) });
    const r = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(prompt).not.toContain("PLAN");
    expect(r.ok && r.doc.picks.map((p) => p.questionId)).toEqual(["q_ffffff01", "q_ffffff02", "q_ffffff03"]);
    expect(r.ok && r.doc.picks.some((p) => p.slot)).toBe(false);
  });

  it("never reads the plan with its switch off, even with one approved", async () => {
    vi.stubEnv("CONTENT_STRATEGY_NEXT_UP_ENABLED", "false");
    const d = await setup({ generate: vi.fn(async () => JSON.stringify({ picks: [] })) });
    const made = await saveMadePlan(A, PLAN, { db: d.db });
    await approvePlan(A, { baseRev: made.ok ? made.value.rev : 0 }, { db: d.db });
    const r = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(r.ok && r.doc.picks.map((p) => p.questionId)).toEqual(["q_ffffff01", "q_ffffff02", "q_ffffff03"]);
  });

  it("offers a combine once, and never fills one in by code", async () => {
    const combine = cand("combine:q_aaaaaa01", { slot: { ...slotOf("slt_aaaaaa01"), action: "combine", kind: "combine" }, combine: { pages: [{ title: "A", url: null, planId: "plan1", workspaceId: "ws1" }, { title: "B", url: null, planId: "plan2", workspaceId: "ws1" }] } });
    let prompt = "";
    const d = await setup({ contentPlan: async () => PLAN, roadmap: async () => [combine, roadmapCand(1)], generate: vi.fn(async (p: string) => ((prompt = p), JSON.stringify({ picks: [] }))) });
    const r = await pickNextUp(A, { by: "person", deadlineMs: Date.now() + 60_000 }, d);
    expect(prompt).toContain('1. PLAN COMBINE "Question combine:q_aaaaaa01?" (two live articles)');
    expect(prompt).toContain("keeps one and folds the other in");
    expect(r.ok && r.doc.picks.map((p) => p.questionId)).toEqual(["q_rrrrrr01", "q_ffffff01", "q_ffffff02"]);
  });
});

describe("the autopilot and a combine pick", () => {
  const runOf = (mode: string) => ({ id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode, question: null }) as unknown as AutopilotRun;
  const pick = (over: Partial<NextUpPick>): NextUpPick => ({ questionId: "q_aaaaaa03", question: "Question?", subjectId: "sub_aaaaaa01", subjectName: "Tracking", because: "Why now.", chips: [], from: "gemini", ...over });

  it("never drafts it: it waits for a person, and the run takes the next pick", async () => {
    const db = new FakeFirestore();
    await forTenant(A, db).nextUp.create("nu_ten_A", {
      picks: [pick({ questionId: "combine:q_aaaaaa01", kind: "combine", combine: { pages: [] } }), pick({ questionId: "q_aaaaaa03" })],
      notOnMap: [],
      missing: [],
      candidates: 2,
      at: NOW.toISOString(),
      by: "person",
    } as never);
    const r = await pickStep(SYSTEM, runOf("draft"), { deadlineMs: Date.now() + 60_000 }, { db, now: () => NOW, loadTenant: async () => null } as never);
    expect(r).toMatchObject({ step: "find", question: { questionId: "q_aaaaaa03" } });
    expect((await readNextUp(A, { db }))?.picks.map((p) => p.questionId)).toEqual(["combine:q_aaaaaa01"]);
  });

  it("a person can say Not now to it, kept on the Learned list in its own words", async () => {
    const db = new FakeFirestore();
    await forTenant(A, db).nextUp.create("nu_ten_A", { picks: [pick({ questionId: "combine:q_aaaaaa01", kind: "combine" })], notOnMap: [], missing: [], candidates: 1, at: NOW.toISOString(), by: "person" } as never);
    const r = await skipPick(A, { questionId: "combine:q_aaaaaa01", question: "AI visibility tracking, explained" }, { db });
    expect(r.status).toBe(200);
    const entry = { id: "l1", tenantId: "ten_A", kind: "skipped_pick" as const, text: "AI visibility tracking, explained", reason: "", questionId: "combine:q_aaaaaa01", from: "person" as const, at: "", by: null };
    expect(learnedLine(entry)).toBe('Skipped combining the live articles that answer: "AI visibility tracking, explained"');
    expect(learnedLine({ ...entry, questionId: "q_aaaaaa01" })).toBe('Skipped as a next article: "AI visibility tracking, explained"');
  });
});

describe("the writer and a slot", () => {
  it("briefs an article written for a slot with the slot's other questions, only with the switch on", async () => {
    const db = await seeded();
    const made = await saveMadePlan(A, PLAN, { db });
    await approvePlan(A, { baseRev: made.ok ? made.value.rev : 0 }, { db });
    expect(await slotQuestionsFor(A, "q_aaaaaa01", { db })).toEqual(["What does AI visibility tracking mean?"]);
    expect(await slotQuestionsFor(A, "q_aaaaaa03", { db })).toEqual([]);
    vi.stubEnv("CONTENT_STRATEGY_NEXT_UP_ENABLED", "false");
    expect(await slotQuestionsFor(A, "q_aaaaaa01", { db })).toEqual([]);
  });
});
