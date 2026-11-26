import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { CONTENT_STRATEGY_LIMITS, ContentPlanSchema, contentStrategyDocId, type ContentPlan, type ContentSlot } from "@/lib/types/contentStrategy";
import {
  applyPlanEdit,
  approvePlan,
  deleteContentStrategy,
  readContentStrategy,
  readContentStrategyDoc,
  saveMadePlan,
  savePlanEdit,
  sizeOf,
  summaryOf,
  withDecisions,
} from "./store";

// Made-up brands and people.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", email: "admin@a.example.com", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "idtoken", userId: "usr_b", role: "admin" };
const T0 = Date.parse("2026-11-25T10:00:00.000Z");
const at = (ms: number) => ({ now: () => new Date(ms) });
const texts: Record<string, string> = { q_aaaaaa01: "What is AI visibility?", q_aaaaaa02: "How is AI visibility tracked?", q_aaaaaa03: "Best GEO tools" };
const look = { questionText: (id: string) => texts[id] ?? null };

function slot(id: string, questionIds: string[], over: Partial<ContentSlot> = {}): ContentSlot {
  return {
    id,
    title: texts[questionIds[0]!] ?? "A question",
    questionIds,
    subjectIds: ["sub_aaaaaa01"],
    stage: "learn",
    kind: "guide",
    pillarId: "pil_aaaaaa01",
    coveredBy: [],
    inProgress: false,
    hub: false,
    scores: { fit: 50, demand: 10, gap: 0, depth: 0, balance: 60, total: 30 },
    facts: { focus: 1, impressions: null, paa: null, theirs: 0, serp: null },
    from: "plan",
    ...over,
  };
}

function plan(over: Partial<ContentPlan> = {}): ContentPlan {
  return ContentPlanSchema.parse({
    slots: [slot("slt_aaaaaa01", ["q_aaaaaa01", "q_aaaaaa02"], { hub: true }), slot("slt_aaaaaa02", ["q_aaaaaa03"], { stage: "consider", kind: "list" })],
    pillars: [{ id: "pil_aaaaaa01", name: "Measure AI visibility", about: "", from: "vizzy", groupId: null, hub: { kind: "slot", slotId: "slt_aaaaaa01" } }],
    roadmap: [
      { week: "2026-W49", slotId: "slt_aaaaaa01", action: "write" },
      { week: "2026-W50", slotId: "slt_aaaaaa02", action: "write" },
    ],
    blocks: [{ month: "2026-12", weeks: ["2026-W49", "2026-W50", "2026-W51", "2026-W52"], pillarIds: ["pil_aaaaaa01"] }],
    rules: { roadmapShare: 0.75, funnel: { learn: 50, consider: 30, choose: 20 }, perWeek: 1, refreshShare: 0.33, oneArticlePerSlot: true, hubFirst: true },
    questions: 3,
    stageMix: { learn: 67, consider: 33, choose: 0 },
    sources: ["brand_map", "meaning"],
    made: { promptId: "content.strategy_plan", version: 1, model: "test-model" },
    at: "2026-11-25T10:00:00.000Z",
    by: null,
    ...over,
  });
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
  vi.stubEnv("CONTENT_STRATEGY_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the content strategy's record", () => {
  it("keeps each brand's plan to itself: another brand reads, edits, approves and deletes nothing of it", async () => {
    const db = new FakeFirestore();
    const made = await saveMadePlan(A, plan(), { db, ...at(T0) });
    expect(made.ok).toBe(true);
    const rev = made.ok ? made.value.rev : 0;
    expect(await readContentStrategyDoc(B, { db })).toBeNull();
    // A guessed id from the other brand is invisible.
    expect(await forTenant(B, db).contentStrategy.getById(contentStrategyDocId("ten_A"))).toBeNull();
    expect(await savePlanEdit(B, { op: "rename_pillar", baseRev: rev, pillarId: "pil_aaaaaa01", name: "Theirs" }, look, { db })).toMatchObject({ ok: false, error: "no_plan" });
    expect(await approvePlan(B, { baseRev: rev }, { db })).toMatchObject({ ok: false, error: "no_draft" });
    expect(await deleteContentStrategy(B, { db })).toBe(false);
    const still = await readContentStrategyDoc(A, { db });
    expect(still?.draft?.pillars[0]?.name).toBe("Measure AI visibility");
    expect(still?.tenantId).toBe("ten_A");
  });

  it("reads the approved plan only, and nothing with the switch off", async () => {
    const db = new FakeFirestore();
    const made = await saveMadePlan(A, plan(), { db, ...at(T0) });
    expect(await readContentStrategy(A, { db })).toBeNull();
    const approved = await approvePlan(A, { baseRev: made.ok ? made.value.rev : 0 }, { db, ...at(T0 + 1000) });
    expect(approved.ok && approved.value.draft).toBeNull();
    expect((await readContentStrategy(A, { db }))?.roadmap).toHaveLength(2);
    vi.stubEnv("CONTENT_STRATEGY_ENABLED", "false");
    expect(await readContentStrategy(A, { db })).toBeNull();
    vi.stubEnv("CONTENT_STRATEGY_ENABLED", "true");
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "false");
    expect(await readContentStrategy(A, { db })).toBeNull();
  });

  it("refuses an approve or edit from an older copy, and an approve with no draft", async () => {
    const db = new FakeFirestore();
    const made = await saveMadePlan(A, plan(), { db, ...at(T0) });
    const rev = made.ok ? made.value.rev : 0;
    expect(await approvePlan(A, { baseRev: rev - 1 }, { db })).toMatchObject({ ok: false, status: 409, error: "plan_changed" });
    expect(await savePlanEdit(A, { op: "skip", baseRev: rev + 3, slotId: "slt_aaaaaa02", reason: "" }, look, { db })).toMatchObject({ ok: false, error: "plan_changed" });
    const ok = await approvePlan(A, { baseRev: rev }, { db });
    expect(ok.ok).toBe(true);
    expect(await approvePlan(A, { baseRev: ok.ok ? ok.value.rev : 0 }, { db })).toMatchObject({ ok: false, error: "no_draft" });
  });

  it("keeps the last 5 approved plans in short, each roadmap entry with its slot's first question", async () => {
    const db = new FakeFirestore();
    for (let i = 0; i < 7; i += 1) {
      const made = await saveMadePlan(A, plan({ pillars: [{ id: "pil_aaaaaa01", name: `Pillar ${i}`, about: "", from: "vizzy", groupId: null, hub: null }] }), { db, ...at(T0 + i * 10_000) });
      await approvePlan(A, { baseRev: made.ok ? made.value.rev : 0 }, { db, ...at(T0 + i * 10_000 + 1) });
    }
    const doc = await readContentStrategyDoc(A, { db });
    expect(doc?.approved?.pillars[0]?.name).toBe("Pillar 6");
    expect(doc?.history.map((h) => h.pillars[0]?.name)).toEqual(["Pillar 5", "Pillar 4", "Pillar 3", "Pillar 2", "Pillar 1"]);
    expect(doc?.history[0]?.roadmap[0]).toEqual({ week: "2026-W49", slotId: "slt_aaaaaa01", action: "write", questionId: "q_aaaaaa01" });
    expect(doc?.history[0]?.slots).toBe(2);
    expect(doc?.decisions.filter((d) => d.kind === "approved")).toHaveLength(7);
  });

  it("caps decisions at 200, newest first", () => {
    const one = (i: number) => ({ kind: "pick_moved" as const, ref: `slt_${i}`, before: null, after: null, at: "", by: null });
    const many = withDecisions(Array.from({ length: 199 }, (_, i) => one(i)), [one(1000), one(1001)]);
    expect(many).toHaveLength(CONTENT_STRATEGY_LIMITS.decisions);
    expect(many[0]?.ref).toBe("slt_1000");
  });

  it("starts a draft from the approved plan when a person edits it, and keeps what they decided", async () => {
    const db = new FakeFirestore();
    const made = await saveMadePlan(A, plan(), { db, ...at(T0) });
    const approved = await approvePlan(A, { baseRev: made.ok ? made.value.rev : 0 }, { db });
    const renamed = await savePlanEdit(A, { op: "rename_pillar", baseRev: approved.ok ? approved.value.rev : 0, pillarId: "pil_aaaaaa01", name: "Track AI answers" }, look, { db });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.draft?.pillars[0]).toMatchObject({ name: "Track AI answers", from: "person" });
    expect(renamed.value.approved?.pillars[0]?.name).toBe("Measure AI visibility");
    expect(renamed.value.decisions[0]).toMatchObject({ kind: "pillar_renamed", before: "Measure AI visibility", after: "Track AI answers", by: "admin@a.example.com" });
  });

  it("removes the plan, its history and its decisions on Start over", async () => {
    const db = new FakeFirestore();
    await saveMadePlan(A, plan(), { db });
    expect(await deleteContentStrategy(A, { db })).toBe(true);
    expect(await readContentStrategyDoc(A, { db })).toBeNull();
  });

  it("keeps a draft and an approved plan of 400 slots under the size limit, holding ids only", () => {
    const big = plan({ slots: Array.from({ length: 400 }, (_, i) => slot(`slt_${String(i).padStart(8, "0")}`, ["q_aaaaaa01", "q_aaaaaa02", "q_aaaaaa03"])) });
    // Two full plans of 400 slots, with question and page ids only, stay under the limit.
    expect(sizeOf({ draft: big, approved: big, history: [summaryOf(big)] })).toBeLessThan(CONTENT_STRATEGY_LIMITS.bytes);
  });
});

describe("a person's change to the plan", () => {
  const AT = "2026-11-26T09:00:00.000Z";

  it("splits a question into a slot of its own, after the one it came from", () => {
    const r = applyPlanEdit(plan(), { op: "split", baseRev: 0, slotId: "slt_aaaaaa01", questionId: "q_aaaaaa02" }, AT, "admin@a.example.com", look);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.slots.map((s) => s.questionIds)).toEqual([["q_aaaaaa01"], ["q_aaaaaa02"], ["q_aaaaaa03"]]);
    expect(r.plan.slots[1]).toMatchObject({ title: "How is AI visibility tracked?", from: "person", hub: false, coveredBy: [] });
    expect(r.decisions[0]).toMatchObject({ kind: "slot_split", ref: "slt_aaaaaa01", before: "q_aaaaaa02" });
  });

  it("splitting the first question names the slot after the next one", () => {
    const r = applyPlanEdit(plan(), { op: "split", baseRev: 0, slotId: "slt_aaaaaa01", questionId: "q_aaaaaa01" }, AT, null, look);
    expect(r.ok && r.plan.slots[0]?.title).toBe("How is AI visibility tracked?");
  });

  it("won't split a slot of one question", () => {
    expect(applyPlanEdit(plan(), { op: "split", baseRev: 0, slotId: "slt_aaaaaa02", questionId: "q_aaaaaa03" }, AT, null, look)).toMatchObject({ ok: false, error: "slot_single" });
    expect(applyPlanEdit(plan(), { op: "split", baseRev: 0, slotId: "slt_aaaaaa02", questionId: "q_aaaaaa01" }, AT, null, look)).toMatchObject({ ok: false, error: "no_slot" });
  });

  it("joins two slots into one article, keeping one roadmap entry and the hub", () => {
    const r = applyPlanEdit(plan(), { op: "join", baseRev: 0, slotId: "slt_aaaaaa01", intoSlotId: "slt_aaaaaa02" }, AT, null, look);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.slots).toHaveLength(1);
    expect(r.plan.slots[0]).toMatchObject({ id: "slt_aaaaaa02", questionIds: ["q_aaaaaa03", "q_aaaaaa01", "q_aaaaaa02"], hub: true, from: "person" });
    expect(r.plan.roadmap).toEqual([{ week: "2026-W49", slotId: "slt_aaaaaa02", action: "write" }]);
    expect(r.plan.pillars[0]?.hub).toEqual({ kind: "slot", slotId: "slt_aaaaaa02" });
    expect(r.decisions[0]).toMatchObject({ kind: "slot_joined", ref: "slt_aaaaaa02", before: "slt_aaaaaa01" });
  });

  it("won't join past 8 questions", () => {
    const full = plan({ slots: [slot("slt_aaaaaa01", Array.from({ length: 8 }, (_, i) => `q_bbbbbb0${i}`)), slot("slt_aaaaaa02", ["q_aaaaaa03"])] });
    expect(applyPlanEdit(full, { op: "join", baseRev: 0, slotId: "slt_aaaaaa02", intoSlotId: "slt_aaaaaa01" }, AT, null, look)).toMatchObject({ ok: false, error: "slot_full" });
  });

  it("a join takes the action its live articles need: one live makes a refresh, two a combine, never a write", () => {
    const done = slot("slt_bbbbbb01", ["q_bbbbbb01"], { coveredBy: ["p_plan1"] });
    const open = slot("slt_bbbbbb02", ["q_bbbbbb02"]);
    const other = slot("slt_bbbbbb03", ["q_bbbbbb03"], { coveredBy: ["p_plan2"], kind: "refresh" });
    const p = plan({ slots: [done, open, other], roadmap: [{ week: "2026-W49", slotId: "slt_bbbbbb02", action: "write" }, { week: "2026-W50", slotId: "slt_bbbbbb03", action: "refresh" }] });
    const one = applyPlanEdit(p, { op: "join", baseRev: 0, slotId: "slt_bbbbbb01", intoSlotId: "slt_bbbbbb02" }, AT, null, look);
    expect(one.ok && one.plan.slots.find((s) => s.id === "slt_bbbbbb02")).toMatchObject({ coveredBy: ["p_plan1"], kind: "refresh" });
    expect(one.ok && one.plan.roadmap[0]).toEqual({ week: "2026-W49", slotId: "slt_bbbbbb02", action: "refresh" });
    if (!one.ok) return;
    const two = applyPlanEdit(one.plan, { op: "join", baseRev: 0, slotId: "slt_bbbbbb03", intoSlotId: "slt_bbbbbb02" }, AT, null, look);
    expect(two.ok && two.plan.slots.find((s) => s.id === "slt_bbbbbb02")).toMatchObject({ coveredBy: ["p_plan1", "p_plan2"], kind: "combine" });
    expect(two.ok && two.plan.roadmap).toEqual([{ week: "2026-W49", slotId: "slt_bbbbbb02", action: "combine" }]);
  });

  it("a split works both slots out from their own questions: coverage, focus, kind, the roadmap action and the scores", () => {
    const both = slot("slt_bbbbbb01", ["q_aaaaaa01", "q_aaaaaa02"], { kind: "combine", coveredBy: ["p_plan1", "p_plan2"], facts: { focus: 1, impressions: 40, paa: null, theirs: 0, serp: null } });
    const p = plan({ slots: [both], roadmap: [{ week: "2026-W49", slotId: "slt_bbbbbb01", action: "combine" }] });
    const q = (id: string, over: object) => ({ id, text: texts[id]!, intent: "definition" as const, subjectId: "sub_aaaaaa01", focus: false, impressions: null, state: "answered" as const, live: [] as string[], ...over });
    const questions = new Map([
      ["q_aaaaaa01", q("q_aaaaaa01", { live: ["p_plan1"], state: "open", impressions: 40 })],
      ["q_aaaaaa02", q("q_aaaaaa02", { live: ["p_plan2"], focus: true })],
    ]);
    const r = applyPlanEdit(p, { op: "split", baseRev: 0, slotId: "slt_bbbbbb01", questionId: "q_aaaaaa02" }, AT, null, { ...look, questions });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [kept, out] = r.plan.slots;
    // Focus is counted once, on the question that has it; each keeps its own live article.
    expect(kept).toMatchObject({ id: "slt_bbbbbb01", coveredBy: ["p_plan1"], kind: "refresh", facts: { focus: 0, impressions: 40 }, scores: { fit: 0 } });
    expect(out).toMatchObject({ questionIds: ["q_aaaaaa02"], coveredBy: ["p_plan2"], facts: { focus: 1, impressions: null }, scores: { fit: 100 } });
    // The kept slot's combine becomes the refresh it needs now; the one split out, done already, isn't scheduled.
    expect(r.plan.roadmap).toEqual([{ week: "2026-W49", slotId: "slt_bbbbbb01", action: "refresh" }]);
  });

  it("skips a pick off the roadmap with its reason, and moves one to another week of the plan", () => {
    const skipped = applyPlanEdit(plan(), { op: "skip", baseRev: 0, slotId: "slt_aaaaaa02", reason: "Not this quarter" }, AT, null, look);
    expect(skipped.ok && skipped.plan.roadmap.map((e) => e.slotId)).toEqual(["slt_aaaaaa01"]);
    expect(skipped.ok && skipped.decisions[0]).toMatchObject({ kind: "pick_skipped", before: "2026-W50", after: "Not this quarter" });
    const moved = applyPlanEdit(plan(), { op: "move", baseRev: 0, slotId: "slt_aaaaaa01", week: "2026-W51" }, AT, null, look);
    expect(moved.ok && moved.plan.roadmap.map((e) => `${e.week} ${e.slotId}`)).toEqual(["2026-W50 slt_aaaaaa02", "2026-W51 slt_aaaaaa01"]);
    expect(moved.ok && moved.decisions[0]).toMatchObject({ kind: "pick_moved", before: "2026-W49", after: "2026-W51" });
    expect(applyPlanEdit(plan(), { op: "move", baseRev: 0, slotId: "slt_aaaaaa01", week: "2027-W30" }, AT, null, look)).toMatchObject({ ok: false, error: "unknown_week" });
    expect(applyPlanEdit(plan(), { op: "skip", baseRev: 0, slotId: "slt_cccccc01", reason: "" }, AT, null, look)).toMatchObject({ ok: false, error: "no_pick" });
  });
});
