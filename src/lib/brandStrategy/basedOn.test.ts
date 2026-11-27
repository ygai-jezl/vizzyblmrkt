import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { startFind } from "@/lib/autopilot/adminApi";
import { pickStep } from "@/lib/autopilot/draftSteps";
import { getRun } from "@/lib/autopilot/runs";
import type { AutopilotRun, NextUpPick } from "@/lib/types/autopilot";
import { BlogBriefSchema } from "@/lib/types/contentPlan";
import { basedOnFor, briefWithPick, keptBasedOn } from "./basedOn";

// Linking the work to the strategy (STRATEGY_RESULTS_ENABLED). Made-up brands and questions.
const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_a", role: "admin" };
const NOW = new Date("2026-11-27T12:00:00.000Z");
const STRATEGY = { at: "2026-11-02T09:00:00.000Z", focusSituationIds: ["sit_aaaaaa01", "sit_aaaaaa02"] };
const BASED = { strategyAt: STRATEGY.at, planAt: null, situationId: "sit_aaaaaa01", slotId: null };
const pick = (over: Partial<NextUpPick> = {}): NextUpPick => ({
  questionId: "q_aaaaaaa1",
  question: "How do I stop back pain at my desk?",
  subjectId: "sub_aaaaaaaa",
  subjectName: "Desk work",
  because: "Why now.",
  chips: [],
  from: "gemini",
  ...over,
});

beforeEach(() => {
  for (const k of ["BRAND_MAP_ENABLED", "BRAND_STRATEGY_ENABLED", "BRAND_MAP_NEXT_UP_ENABLED", "STRATEGY_RESULTS_ENABLED"]) vi.stubEnv(k, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("basedOnFor", () => {
  it("names the approved strategy, the focus situation it serves and the plan's slot it fills", () => {
    expect(basedOnFor({ strategy: STRATEGY, plan: { at: "2026-11-03T09:00:00.000Z" }, situationId: "sit_aaaaaa02", slotId: "slt_aaaaaa01" })).toEqual({
      strategyAt: STRATEGY.at,
      planAt: "2026-11-03T09:00:00.000Z",
      situationId: "sit_aaaaaa02",
      slotId: "slt_aaaaaa01",
    });
    // A free pick: no plan, no slot.
    expect(basedOnFor({ strategy: STRATEGY, plan: { at: "2026-11-03T09:00:00.000Z" }, situationId: "sit_aaaaaa01" })).toEqual(BASED);
    // A situation that isn't a focus one is never named.
    expect(basedOnFor({ strategy: STRATEGY, plan: null, situationId: "sit_zzzzzz09" })).toEqual({ ...BASED, situationId: null });
    // Only the plan: its slot, no strategy.
    expect(basedOnFor({ strategy: null, plan: { at: "2026-11-03T09:00:00.000Z" }, situationId: "sit_aaaaaa01", slotId: "slt_aaaaaa01" })).toEqual({ strategyAt: null, planAt: "2026-11-03T09:00:00.000Z", situationId: null, slotId: "slt_aaaaaa01" });
  });

  it("is absent when nothing approved made it", () => {
    expect(basedOnFor({ strategy: null, plan: null, situationId: "sit_aaaaaa01", slotId: "slt_aaaaaa01" })).toBeUndefined();
    expect(basedOnFor({ strategy: null, plan: { at: "2026-11-03T09:00:00.000Z" } })).toBeUndefined();
  });

  it("is read from briefs made before it as absent, and a broken one as absent", () => {
    expect(BlogBriefSchema.parse({}).basedOn).toBeUndefined();
    expect(BlogBriefSchema.parse({ basedOn: "nonsense" }).basedOn).toBeUndefined();
    expect(BlogBriefSchema.parse({ basedOn: BASED }).basedOn).toEqual(BASED);
    expect(BlogBriefSchema.parse({ basedOn: { strategyAt: STRATEGY.at } }).basedOn).toEqual({ strategyAt: STRATEGY.at, planAt: null, situationId: null, slotId: null });
  });
});

async function seedPicks(db: FakeFirestore, tenant: TenantContext, picks: NextUpPick[]) {
  await forTenant(tenant, db).nextUp.create(`nu_${tenant.tenantId}`, { picks, notOnMap: [], missing: [], candidates: 3, at: NOW.toISOString(), by: "person" } as never);
}
const runOf = (mode: string) => ({ id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode, question: null }) as unknown as AutopilotRun;

describe("a run started from a pick", () => {
  it("keeps what the pick came from, only with the switch on", async () => {
    const db = new FakeFirestore();
    await seedPicks(db, A, [pick({ basedOn: BASED })]);
    const r = await pickStep(A, runOf("suggest"), { deadlineMs: Date.now() + 60_000 }, { db, now: () => NOW } as never);
    expect(r).toMatchObject({ step: "find", question: { questionId: "q_aaaaaaa1" }, basedOn: BASED });
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "false");
    const db2 = new FakeFirestore();
    await seedPicks(db2, A, [pick({ basedOn: BASED })]);
    expect(await pickStep(A, runOf("suggest"), { deadlineMs: Date.now() + 60_000 }, { db: db2, now: () => NOW } as never)).not.toHaveProperty("basedOn");
  });

  it("a person's Find takes it from the stored pick, never from what the page sends, and never another brand's", async () => {
    const db = new FakeFirestore();
    await seedPicks(db, A, [pick({ basedOn: BASED })]);
    await seedPicks(db, { ...A, tenantId: "ten_B" }, [pick({ questionId: "q_bbbbbbb1", basedOn: { ...BASED, situationId: "sit_bbbbbb01" } })]);
    const deps = { db, now: () => NOW, canUse: async () => true, rateLimited: async () => false, advance: async () => null } as never;
    const body = { questionId: "q_aaaaaaa1", question: "How do I stop back pain at my desk?", subjectId: "sub_aaaaaaaa", subjectName: "Desk work", basedOn: { strategyAt: "forged" } };
    const started = await startFind(A, body, deps);
    const id = (started.body as { run: { id: string } }).run.id;
    expect((await getRun(A, id, { db }))?.basedOn).toEqual(BASED);
    // A question the brand's Next up doesn't hold gets nothing, even if another brand's does.
    const other = await startFind(A, { ...body, questionId: "q_bbbbbbb1" }, deps);
    expect((await getRun(A, (other.body as { run: { id: string } }).run.id, { db }))?.basedOn).toBeUndefined();
  });
});

describe("an article written from a Next up pick (Write it)", () => {
  it("takes what the stored pick came from, by the brief's question, only with the switch on", async () => {
    const db = new FakeFirestore();
    await seedPicks(db, A, [pick({ basedOn: BASED })]);
    expect(await briefWithPick(A, { primaryRef: "q_aaaaaaa1" }, { db })).toEqual({ primaryRef: "q_aaaaaaa1", basedOn: BASED });
    // A question Next up doesn't hold, a brief with no question, or another brand: nothing added.
    expect(await briefWithPick(A, { primaryRef: "q_zzzzzzz9" }, { db })).toEqual({ primaryRef: "q_zzzzzzz9" });
    expect(await briefWithPick(A, {}, { db })).toEqual({});
    expect(await briefWithPick({ ...A, tenantId: "ten_B" }, { primaryRef: "q_aaaaaaa1" }, { db })).toEqual({ primaryRef: "q_aaaaaaa1" });
    vi.stubEnv("STRATEGY_RESULTS_ENABLED", "false");
    expect(await briefWithPick(A, { primaryRef: "q_aaaaaaa1" }, { db })).toEqual({ primaryRef: "q_aaaaaaa1" });
  });

  it("never takes a basedOn the page sends: a saved brief keeps the stored one, or none", () => {
    const forged = { ...BASED, situationId: "sit_zzzzzz99" };
    expect(keptBasedOn({ primaryRef: "q_aaaaaaa1", basedOn: forged }, { basedOn: BASED })).toEqual({ primaryRef: "q_aaaaaaa1", basedOn: BASED });
    expect(keptBasedOn({ primaryRef: "q_aaaaaaa1", basedOn: forged }, null)).toEqual({ primaryRef: "q_aaaaaaa1" });
    const plain: { primaryRef: string; basedOn?: typeof BASED } = { primaryRef: "q_aaaaaaa1" };
    expect(keptBasedOn(plain, { basedOn: BASED })).toEqual({ primaryRef: "q_aaaaaaa1", basedOn: BASED });
  });
});
