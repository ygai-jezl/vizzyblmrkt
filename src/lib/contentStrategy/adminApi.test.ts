import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLearned } from "@/lib/autopilot/learned";
import { saveBrandMap } from "@/lib/brandMap/store";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { ContentPlanSchema } from "@/lib/types/contentStrategy";
import { editFromRequest, nextEntries, planView, skipIdOf, viewFromRequest } from "./adminApi";
import { saveMadePlan } from "./store";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", email: "admin@a.example.com", role: "admin" };
const NOW = new Date("2026-11-26T10:00:00.000Z");

const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme" },
  subjects: [
    {
      id: "sub_aaaaaa01",
      name: "Tracking",
      questions: [
        { id: "q_aaaaaa01", text: "What is AI visibility tracking?", intent: "definition" },
        { id: "q_aaaaaa02", text: "What does AI visibility tracking mean?", intent: "definition" },
        { id: "q_aaaaaa03", text: "Is there a free llms.txt checker?", intent: "other" },
      ],
    },
  ],
});

const scores = { fit: 0, demand: 0, gap: 0, depth: 0, balance: 100, total: 15 };
const facts = { focus: 0, impressions: null, paa: null, theirs: 0, serp: null };
const plan = ContentPlanSchema.parse({
  slots: [
    { id: "slt_aaaaaa01", title: "What is AI visibility tracking?", questionIds: ["q_aaaaaa01", "q_aaaaaa02"], subjectIds: ["sub_aaaaaa01"], stage: "learn", kind: "combine", pillarId: "pil_aaaaaa01", coveredBy: ["p_plan1", "p_plan2"], hub: true, scores, facts },
    { id: "slt_aaaaaa02", title: "Is there a free llms.txt checker?", questionIds: ["q_aaaaaa03"], subjectIds: ["sub_aaaaaa01"], stage: "learn", kind: "tool", pillarId: "pil_aaaaaa01", scores, facts },
  ],
  pillars: [{ id: "pil_aaaaaa01", name: "Measure AI visibility", hub: { kind: "slot", slotId: "slt_aaaaaa01" } }],
  roadmap: [{ week: "2026-W48", slotId: "slt_aaaaaa01", action: "combine" }],
  blocks: [{ month: "2026-11", weeks: ["2026-W48", "2026-W49", "2026-W50", "2026-W51"], pillarIds: ["pil_aaaaaa01"] }],
  questions: 3,
  stageMix: { learn: 100, consider: 0, choose: 0 },
  sources: ["brand_map", "repeats"],
  at: "2026-11-26T09:00:00.000Z",
});

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
  vi.stubEnv("CONTENT_STRATEGY_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function seeded() {
  const db = new FakeFirestore();
  await saveBrandMap(A, { baseRev: 0, decided: DECIDED }, { db });
  // Both live articles answer the first question: a combine.
  db.seed("brand_map_pages", "p_plan1", { tenantId: "ten_A", kind: "article", title: "What Is AI Search Visibility Tracking", url: "https://a.example.com/one", state: "live", primaryRef: "q_aaaaaa01" } as never);
  db.seed("brand_map_pages", "p_plan2", { tenantId: "ten_A", kind: "article", title: "AI visibility tracking, explained", url: "https://a.example.com/two", state: "live", primaryRef: "q_aaaaaa01" } as never);
  const saved = await saveMadePlan(A, plan, { db });
  return { db, rev: saved.ok ? saved.value.rev : 0 };
}

describe("the Content plan section", () => {
  it("shows the pillars, the next weeks with why and their live articles, the funnel and what isn't an article", async () => {
    const { db } = await seeded();
    const v = await planView(A, { db, now: () => NOW });
    expect(v.state).toBe("draft");
    expect(v.pillars[0]).toMatchObject({ name: "Measure AI visibility", slots: 2, live: 1, open: 0, hub: { kind: "slot", title: "What is AI visibility tracking?", live: true }, focus: ["2026-11"] });
    expect(v.next).toHaveLength(1);
    expect(v.next[0]).toMatchObject({ week: "2026-W48", action: "combine", kind: "combine", pillar: "Measure AI visibility" });
    expect(v.next[0]!.live.map((p) => p.title)).toEqual(["What Is AI Search Visibility Tracking", "AI visibility tracking, explained"]);
    expect(v.next[0]!.why[0]).toBe("2 live articles answer it: keep one and fold the other in");
    expect(v.notArticles).toEqual([{ title: "Is there a free llms.txt checker?", kind: "tool" }]);
    expect(v.funnel).toMatchObject({ target: { learn: 50, consider: 30, choose: 20 }, questions: { learn: 100 } });
    expect(v.sources).toEqual(["Your brand map's questions", "Live articles that repeat each other"]);
  });

  it("shows only this week's entries on, three weeks at most", () => {
    const p = ContentPlanSchema.parse({ ...plan, roadmap: ["2026-W46", "2026-W48", "2026-W49", "2026-W50", "2026-W51"].map((week, i) => ({ week, slotId: `slt_bbbbbb0${i}`, action: "write" })) });
    expect(nextEntries(p, "2026-W48").map((e) => e.week)).toEqual(["2026-W48", "2026-W49", "2026-W50"]);
  });

  it("gives one pillar's slots with their questions' words", async () => {
    const { db } = await seeded();
    const res = await viewFromRequest(A, "http://localhost/x?pillar=pil_aaaaaa01", { db });
    const body = (await res.json()) as { slots: Array<{ questions: Array<{ text: string }> }> };
    expect(body.slots[0]!.questions.map((q) => q.text)).toEqual(["What is AI visibility tracking?", "What does AI visibility tracking mean?"]);
  });

  it("splits a question out under its own words, and keeps a skipped combine on the Learned list for the next plan and Next up", async () => {
    const { db, rev } = await seeded();
    const split = await editFromRequest(A, { op: "split", baseRev: rev, slotId: "slt_aaaaaa01", questionId: "q_aaaaaa02" }, { db, now: () => NOW });
    const after = (await split.json()) as { plan: { rev: number; slots: Array<{ title: string; kind: string; live: number }> } };
    expect(after.plan.slots.map((s) => [s.title, s.kind, s.live])).toEqual([
      ["What is AI visibility tracking?", "combine", 2],
      ["What does AI visibility tracking mean?", "guide", 0],
      ["Is there a free llms.txt checker?", "tool", 0],
    ]);
    const skipped = await editFromRequest(A, { op: "skip", baseRev: after.plan.rev, slotId: "slt_aaaaaa01", reason: "Keep both for now" }, { db, now: () => NOW });
    expect(skipped.status).toBe(200);
    const learned = await listLearned(A, { db });
    expect(learned[0]).toMatchObject({ kind: "skipped_pick", questionId: "combine:q_aaaaaa01", reason: "Keep both for now" });
    // An edit from an older copy is refused.
    const stale = await editFromRequest(A, { op: "skip", baseRev: rev, slotId: "slt_aaaaaa02", reason: "" }, { db });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "plan_changed" });
  });

  it("skips a refresh under the id Next up gives it, so Next up stops offering that refresh", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: DECIDED }, { db });
    const refresh = ContentPlanSchema.parse({
      ...plan,
      slots: [{ ...plan.slots[1]!, id: "slt_aaaaaa03", title: "Is there a free llms.txt checker?", kind: "refresh", coveredBy: ["p_plan9"] }],
      roadmap: [{ week: "2026-W48", slotId: "slt_aaaaaa03", action: "refresh" }],
    });
    const saved = await saveMadePlan(A, refresh, { db });
    const r = await editFromRequest(A, { op: "skip", baseRev: saved.ok ? saved.value.rev : 0, slotId: "slt_aaaaaa03", reason: "" }, { db });
    expect(r.status).toBe(200);
    expect((await listLearned(A, { db }))[0]).toMatchObject({ kind: "skipped_pick", questionId: "refresh:plan9" });
    expect(skipIdOf({ questionIds: ["q_aaaaaa03"], coveredBy: ["p_plan9"] }, "write")).toBe("q_aaaaaa03");
    expect(skipIdOf({ questionIds: ["q_aaaaaa03"], coveredBy: ["s_site1"] }, "refresh")).toBe("q_aaaaaa03");
  });
});
