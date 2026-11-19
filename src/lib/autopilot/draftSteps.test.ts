import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { AutopilotRun } from "@/lib/types/autopilot";

// The pipeline the canvas uses, faked: each saves what it did, as the real ones do.
const shared = vi.hoisted(() => ({ db: null as unknown as FakeFirestore }));
const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, role: type, status: "empty", body: "", position: { x: 0, y: 0 }, ...extra });
vi.mock("@/lib/content/blog/mapActions", () => ({ reconcileWithSavedMap: async (_ctx: unknown, b: unknown) => b }));
vi.mock("@/lib/content/create/architectRun", () => ({
  runArchitect: vi.fn(async () => ({ ok: true, graph: { nodes: [node("hub", "hub", { channel: "blog" }), node("pre", "promo_pre", { channel: "linkedin" }), node("li", "spoke", { channel: "linkedin" })], edges: [] } })),
}));
vi.mock("@/lib/content/blog/hubActions", async () => {
  const wc = await import("@/lib/tenant/workspaceContent");
  return {
    researchPlanBlog: vi.fn(async (ctx: TenantContext, { workspace, plan }: { workspace: { id: string }; plan: ContentPlan }) => {
      await wc.updateContentPlan(ctx, workspace.id, plan.id, { blog: { ...plan.blog!, researchedAt: "2026-11-18T12:00:00.000Z" } }, shared.db);
      return { ok: true };
    }),
    matchPlanSeen: vi.fn(async () => ({ ok: true, seen: { questions: [{ id: "note_1", question: "What did clients ask?", answer: "" }] } })),
    checkPlanBlogFacts: vi.fn(async () => ({ ok: true })),
  };
});
vi.mock("@/lib/content/create/fillPlan", async () => {
  const wc = await import("@/lib/tenant/workspaceContent");
  return {
    fillPlanNode: vi.fn(async (ctx: TenantContext, { workspace, plan, nodeId }: { workspace: { id: string }; plan: ContentPlan; nodeId: string }) => {
      const nodes = plan.graph.nodes.map((n) => (n.id === nodeId ? { ...n, status: "generated" as const, body: `Written: ${nodeId}` } : n));
      await wc.updateContentPlan(ctx, workspace.id, plan.id, { graph: { ...plan.graph, nodes } }, shared.db);
      return { ok: true, node: nodes.find((n) => n.id === nodeId) };
    }),
  };
});

const { advanceRun } = await import("./advance");
const { DRAFT_STEPS, releasePlan } = await import("./draftSteps");
const { createRun, getRun } = await import("./runs");
const { takeOver } = await import("./takeOver");
const { getContentPlan, listContentPlans, updateContentPlan } = await import("@/lib/tenant/workspaceContent");
const { forTenant } = await import("@/lib/tenant");
const { nextArticleItems } = await import("@/lib/review/summary");
const { isoWeek, runAutopilot } = await import("./tick");

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const Q = { questionId: "q_aaaaaaa1", text: "How do I get cited by AI answers?", subjectId: "sub_aaaaaaaa", subjectName: "Getting cited" };
const TRAYS = { use: [{ text: "How does ChatGPT choose sources?", kind: "paa" as const, reason: "fits", subject: null, you: null, them: null }], other: [], drop: [] };

function setup(tenant: Record<string, unknown> = {}) {
  const db = new FakeFirestore();
  shared.db = db;
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "Blog", archivedAt: null } as never);
  const clock = { t: Date.parse("2026-11-16T09:00:00.000Z") };
  const deps = {
    db,
    now: () => new Date(clock.t),
    loadTenant: async () => ({ id: "ten_A", region: "us", grantedFeatures: ["next_up", "article_autopilot"], autopilot: { mode: "draft", workspaceId: "ws1", channels: ["linkedin"] }, ...tenant }) as never,
    steps: DRAFT_STEPS,
    onEnded: (c: TenantContext, r: AutopilotRun) => releasePlan(c, r, { db }),
  };
  return { db, deps, clock };
}

async function draftRun(deps: ReturnType<typeof setup>["deps"]) {
  const run = await createRun(A, { id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode: "draft", trigger: "schedule", step: "create", question: Q }, deps);
  await forTenant(A, deps.db).autopilotRuns.update(run.id, { trays: TRAYS });
  return run.id;
}

const step = (id: string, deps: ReturnType<typeof setup>["deps"]) => advanceRun(A, id, { deadlineMs: Date.now() + 100_000 }, deps as never);

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_NEXT_UP_ENABLED", "true");
  vi.stubEnv("CREATE_ARTICLE_AUTOPILOT_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("a Draft run", () => {
  it("makes the full workflow, step by step, locked while it writes, and never approves or schedules it", async () => {
    const { deps } = setup();
    const id = await draftRun(deps);
    expect(await step(id, deps)).toMatchObject({ step: "seen", planId: "ap_aaaaaaaaaaaaaaaaaaaaaaaa", workspaceId: "ws1" });
    const plan = await getContentPlan(A, "ws1", "ap_aaaaaaaaaaaaaaaaaaaaaaaa", deps.db);
    expect(plan).toMatchObject({ authoredBy: "agent", agentBrief: `autopilot:${id}`, autopilot: { runId: id, state: "working" } });
    expect(plan!.topology).toMatchObject({ hubChannel: "blog", spokeChannels: ["linkedin"] });
    expect(plan!.blog!.buyerQuestions).toBe("How does ChatGPT choose sources?");

    expect(await step(id, deps)).toMatchObject({ step: "write", askedIds: ["note_1"] });
    expect(await step(id, deps)).toMatchObject({ step: "check" });
    expect(await step(id, deps)).toMatchObject({ step: "nodes", nodesLeft: ["pre", "li"] });
    expect(await step(id, deps)).toMatchObject({ step: "done", active: false });
    const done = await getContentPlan(A, "ws1", "ap_aaaaaaaaaaaaaaaaaaaaaaaa", deps.db);
    expect(done!.autopilot!.state).toBe("done");
    expect(done!.graph.nodes.map((n) => [n.id, n.status])).toEqual([
      ["hub", "generated"],
      ["pre", "generated"],
      ["li", "generated"],
    ]);
    expect(done!.graph.nodes.every((n) => !n.scheduledAt)).toBe(true);
  });

  it("finds its own plan again after a crash, never a second one", async () => {
    const { deps } = setup();
    const id = await draftRun(deps);
    await step(id, deps);
    await forTenant(A, deps.db).autopilotRuns.update(id, { step: "create", active: true });
    await step(id, deps);
    expect((await listContentPlans(A, "ws1", 100, deps.db)).length).toBe(1);
  });

  it("stops when a person takes over, and when the article was approved meanwhile", async () => {
    const { deps } = setup();
    const id = await draftRun(deps);
    await step(id, deps);
    await takeOver(A, "ws1", "ap_aaaaaaaaaaaaaaaaaaaaaaaa", { db: deps.db });
    expect(await getRun(A, id, deps)).toMatchObject({ step: "stopped", active: false });

    const second = setup();
    const id2 = await draftRun(second.deps);
    await step(id2, second.deps);
    const plan = (await getContentPlan(A, "ws1", "ap_aaaaaaaaaaaaaaaaaaaaaaaa", second.deps.db))!;
    await updateContentPlan(A, "ws1", plan.id, { graph: { ...plan.graph, nodes: plan.graph.nodes.map((n) => (n.type === "hub" ? { ...n, status: "approved" as const } : n)) } }, second.deps.db);
    expect(await step(id2, second.deps)).toMatchObject({ step: "stopped", error: "approved" });
  });

  it("stays a suggestion at the brand's monthly cap, or without the Draft feature", async () => {
    const { deps } = setup({ featureLimits: { article_autopilot: 0 } });
    const id = await draftRun(deps);
    expect(await step(id, deps)).toMatchObject({ step: "sorted", error: "monthly_limit" });
    const other = setup({ grantedFeatures: ["next_up"] });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "next_up,article_autopilot");
    const id2 = await draftRun(other.deps);
    expect(await step(id2, other.deps)).toMatchObject({ step: "sorted", error: "not_included" });
  });

  it("fails without a programme to write into, and lets go of a plan when it ends early", async () => {
    const { deps } = setup({ autopilot: { mode: "draft", workspaceId: "ws_gone", channels: [] } });
    const id = await draftRun(deps);
    expect(await step(id, deps)).toMatchObject({ step: "failed", error: "no_programme" });
  });
});

describe("the autopilot lane", () => {
  it("knows the week", () => {
    expect(isoWeek(new Date("2026-11-16T09:00:00.000Z"))).toBe("2026-W47");
    expect(isoWeek(new Date("2027-01-01T09:00:00.000Z"))).toBe("2026-W53");
  });

  it("starts one run on the brand's day, never a second while one is going, and nothing when it's off", async () => {
    const { deps, clock } = setup();
    const tenant = { id: "ten_A", region: "us", grantedFeatures: [], autopilot: { mode: "suggest", weekday: 1, perWeek: 2, channels: [] } };
    // A Monday; a picker with nothing to pick stops the run, which is fine here.
    const got = await runAutopilot({ deadlineMs: Date.now() + 100_000 }, { ...deps, listTenants: async () => [tenant as never], clock: () => clock.t });
    expect(got.started).toBe(1);
    clock.t += 24 * 3_600_000;
    expect((await runAutopilot({ deadlineMs: Date.now() + 100_000 }, { ...deps, listTenants: async () => [tenant as never], clock: () => clock.t })).started).toBe(0);
    vi.stubEnv("CREATE_ARTICLE_AUTOPILOT_ENABLED", "false");
    expect(await runAutopilot({ deadlineMs: Date.now() + 100_000 }, { ...deps, listTenants: async () => [tenant as never], clock: () => clock.t })).toEqual({ tenants: 0, started: 0, advanced: 0 });
  });
});

describe("Review rows", () => {
  const base = { id: "run_1", tenantId: "ten_A", trigger: "schedule", question: Q, trays: TRAYS, askedIds: [], planId: null, workspaceId: null, updatedAt: "2026-11-18T12:00:00.000Z", error: null } as never;
  it("shows a sorted suggestion, a draft's questions and a run that couldn't finish", () => {
    const now = Date.parse("2026-11-18T13:00:00.000Z");
    const items = nextArticleItems(
      [
        { ...(base as object), mode: "suggest", step: "sorted" } as never,
        { ...(base as object), id: "run_2", mode: "draft", step: "done", askedIds: ["n1", "n2"], planId: "ap_x", workspaceId: "ws1" } as never,
        { ...(base as object), id: "run_3", mode: "draft", step: "failed", error: "no_programme" } as never,
      ],
      now,
    );
    expect(items.map((i) => i.title)).toEqual([
      "Next article ready to write: “How do I get cited by AI answers?”",
      "2 questions for your next article",
      "Autopilot couldn't finish: “How do I get cited by AI answers?”",
    ]);
    expect(items[1]!.href).toBe("/admin/workspace/ws1/create/ap_x");
    expect(nextArticleItems([{ ...(base as object), mode: "suggest", step: "sorted" } as never], now + 30 * 86_400_000)).toEqual([]);
  });
});
