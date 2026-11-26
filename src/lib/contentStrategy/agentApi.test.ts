import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEANINGS } from "@/lib/metrics/meanings";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { ContentPlanSchema } from "@/lib/types/contentStrategy";
import { agentContentStrategy } from "./agentApi";
import { approvePlan, saveMadePlan } from "./store";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "agent" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "agent" };
const NOW = new Date("2026-11-26T12:00:00.000Z");
const scores = { fit: 80, demand: 40, gap: 70, depth: 30, balance: 90, total: 66 };
const facts = { focus: 2, impressions: 900, paa: null, theirs: 2, serp: "same" };
const PLAN = ContentPlanSchema.parse({
  slots: [
    { id: "slt_aaaaaa01", title: "AI visibility tracking, explained", questionIds: ["q_aaaaaa01", "q_aaaaaa02"], subjectIds: ["sub_aaaaaa01"], pillarId: "pil_aaaaaa01", hub: true, scores, facts },
    { id: "slt_aaaaaa02", title: "A free llms.txt checker", questionIds: ["q_aaaaaa03"], kind: "tool", pillarId: "pil_aaaaaa01", scores, facts },
    { id: "slt_aaaaaa03", title: "Two live articles on audits", questionIds: ["q_aaaaaa04"], kind: "combine", pillarId: "pil_aaaaaa01", coveredBy: ["p_plan1", "p_plan2"], scores, facts },
  ],
  pillars: [{ id: "pil_aaaaaa01", name: "Measure AI visibility", about: "Tracking and audits", hub: { kind: "slot", slotId: "slt_aaaaaa01" } }],
  roadmap: [
    { week: "2026-W48", slotId: "slt_aaaaaa01", action: "write" },
    { week: "2026-W49", slotId: "slt_aaaaaa03", action: "combine" },
  ],
  blocks: [{ month: "2026-11", weeks: ["2026-W48", "2026-W49", "2026-W50", "2026-W51"], pillarIds: ["pil_aaaaaa01"] }],
  rules: { perWeek: 1, refreshShare: 0.33 },
  questions: 4,
  stageMix: { learn: 75, consider: 25, choose: 0 },
  at: "2026-11-26T09:00:00.000Z",
});

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
  vi.stubEnv("CONTENT_STRATEGY_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy's get_content_strategy", () => {
  it("says there is none yet, or that a draft waits, with no numbers", async () => {
    const db = new FakeFirestore();
    expect((await agentContentStrategy(A, { db })).body).toMatchObject({ approved: null, draftWaiting: false });
    await saveMadePlan(A, PLAN, { db });
    expect((await agentContentStrategy(A, { db })).body).toMatchObject({ approved: null, draftWaiting: true });
  });

  it("reads the approved plan's pillars, next weeks and counts, every number with its meaning, and only this brand's", async () => {
    const db = new FakeFirestore();
    db.seed("brand_map_pages", "p_plan1", { tenantId: "ten_A", kind: "article", title: "Audits, one", url: "https://a.example.com/1", state: "live" } as never);
    const made = await saveMadePlan(A, PLAN, { db });
    await approvePlan(A, { baseRev: made.ok ? made.value.rev : 0 }, { db });
    const r = await agentContentStrategy(A, { db, now: () => NOW });
    const body = r.body as Record<string, unknown> & { meanings: Record<string, unknown>; nextWeeks: Array<Record<string, unknown>>; pillars: Array<Record<string, unknown>> };
    expect(body.pillars[0]).toMatchObject({ name: "Measure AI visibility", slotCount: 3, liveSlots: 1, openSlots: 1, hub: "to write first: AI visibility tracking, explained", focusMonths: ["2026-11"] });
    expect(body.nextWeeks.map((e) => [e.week, e.action])).toEqual([
      ["2026-W48", "write"],
      ["2026-W49", "combine"],
    ]);
    expect(body.nextWeeks[0]).toMatchObject({ questionsInSlot: 2, scores: { fitScore: 80, slotScore: 66 }, hub: true });
    expect(body.nextWeeks[1]!.liveArticles).toEqual([{ title: "Audits, one", url: "https://a.example.com/1" }]);
    expect(body.notArticles).toEqual([{ title: "A free llms.txt checker", kindOfPage: "tool page" }]);
    expect(body.counts).toEqual({ slotCount: 3, liveSlots: 1, openSlots: 1, questionsInPlan: 4 });
    expect(body.rules).toMatchObject({ roadmapSharePercent: 75, articlesPerWeek: 1, refreshSharePercent: 33 });
    const numbers = ["slotCount", "liveSlots", "openSlots", "questionsInPlan", "questionsInSlot", "roadmapSharePercent", "articlesPerWeek", "refreshSharePercent", "targetPercent", "questionsPercent", "roadmapPercent", "fitScore", "demandScore", "gapScore", "depthScore", "balanceScore", "slotScore"];
    expect(Object.keys(body.meanings).sort()).toEqual([...numbers].sort());
    for (const k of numbers) expect(MEANINGS).toHaveProperty(k);
    expect((await agentContentStrategy(B, { db })).body).toMatchObject({ approved: null, draftWaiting: false });
  });
});
