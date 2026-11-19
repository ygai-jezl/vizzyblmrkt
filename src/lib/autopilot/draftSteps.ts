import { createHash } from "node:crypto";
import { reconcileWithSavedMap } from "@/lib/content/blog/mapActions";
import { checkPlanBlogFacts, matchPlanSeen, researchPlanBlog } from "@/lib/content/blog/hubActions";
import { runArchitect } from "@/lib/content/create/architectRun";
import { fillPlanNode } from "@/lib/content/create/fillPlan";
import { IntakeSchema, planFromIntake } from "@/lib/content/create/intake";
import { dropPick, pickNextUp, readNextUp } from "@/lib/nextUp/pick";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { monthlyLimit } from "@/lib/plans/limits";
import { forTenant, getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { createContentPlan, getContentPlan, updateContentPlan } from "@/lib/tenant/workspaceContent";
import { AutopilotSettingsSchema, type AutopilotRun } from "@/lib/types/autopilot";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import type { Workspace } from "@/lib/types/workspace";
import type { AdvanceDeps, StepFn } from "./advance";
import { activeRuns, draftsThisMonth, notePlan, type StepPatch } from "./runs";

/**
 * The run's own steps, past find and sort: picking the question (a scheduled run), then in Draft
 * mode making the workflow and writing it (the article, its teaser, its promo and a post per
 * channel). Each step reads the plan fresh, does its part through the same server functions the
 * canvas uses, saves it, and is safe to run again. Before each, the run stops itself if the plan
 * is gone, a person took over, or its hub was approved. Nothing is ever scheduled or published.
 */

export interface DraftDeps extends AdvanceDeps {
  loadTenant?: (id: string) => Promise<Tenant | null>;
}

/** Next up is chosen again when older than this. */
const STALE_PICKS_MS = 7 * 24 * 60 * 60_000;
/** Kept back from the lane's deadline for saving. */
const SAVE_MS = 8_000;
/** One teaser, promo or post may take this long. */
const NODE_MS = 25_000;

export const DRAFT_STEP_MS: Partial<Record<AutopilotRun["step"], number>> = {
  pick: 45_000,
  create: 65_000,
  seen: 50_000,
  write: 70_000,
  check: 60_000,
  nodes: NODE_MS + 5_000,
};

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const left = (opts: { deadlineMs: number }) => opts.deadlineMs - Date.now();

async function workspaceOf(ctx: TenantContext, id: string, deps: DraftDeps): Promise<Workspace | null> {
  return forTenant(ctx, deps.db).workspaces.getById(id);
}

/** The run's plan and programme, or why the run stops. */
async function ours(ctx: TenantContext, run: AutopilotRun, deps: DraftDeps): Promise<{ plan: ContentPlan; workspace: Workspace } | StepPatch> {
  if (!run.planId || !run.workspaceId) return { step: "failed", error: "no_plan" };
  const [plan, workspace] = await Promise.all([getContentPlan(ctx, run.workspaceId, run.planId, deps.db), workspaceOf(ctx, run.workspaceId, deps)]);
  if (!plan || !workspace) return { step: "stopped", error: "plan_gone" };
  if (plan.autopilot?.runId !== run.id || plan.autopilot.state !== "working") return { step: "stopped", error: "taken_over" };
  if (plan.graph.nodes.some((n) => n.type === "hub" && n.status === "approved")) return { step: "stopped", error: "approved" };
  return { plan, workspace };
}
const stopped = (x: unknown): x is StepPatch => Boolean(x && typeof x === "object" && "step" in x);

/** A scheduled run takes Next up's best pick no other run has (choosing again when Next up is old). */
export const pickStep: StepFn = async (ctx, run, opts, deps: DraftDeps) => {
  if (run.question) return { step: "find" };
  const others = (await activeRuns(ctx, deps)).filter((r) => r.id !== run.id && r.question).map((r) => r.question!.questionId);
  let doc = await readNextUp(ctx, deps);
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (!doc || !doc.picks.some((p) => !others.includes(p.questionId)) || now - Date.parse(doc.at) > STALE_PICKS_MS) {
    const got = await pickNextUp(ctx, { by: "schedule", deadlineMs: opts.deadlineMs - 5_000 }, {
      db: deps.db,
      loadTenant: (deps as DraftDeps).loadTenant,
      activeQuestionIds: async () => others,
      ...(deps.search ? { search: deps.search } : {}),
    });
    doc = got.ok ? got.doc : doc;
  }
  const pick = doc?.picks.find((p) => !others.includes(p.questionId));
  if (!pick) return { step: "stopped", error: "nothing_to_pick" };
  await dropPick(ctx, pick.questionId, deps);
  return { step: "find", question: { questionId: pick.questionId, text: pick.question, subjectId: pick.subjectId, subjectName: pick.subjectName } };
};

/** Draft mode: make the workflow in the brand's programme, then plan it and research it together. */
export const createStep: StepFn = async (ctx, run, opts, deps: DraftDeps) => {
  if (run.mode !== "draft" || !run.question) return { step: "sorted" };
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const settings = AutopilotSettingsSchema.parse(tenant?.autopilot ?? {});
  if (!tenantMayUse(tenant, "article_autopilot")) return { step: "sorted", error: "not_included" };

  let planId = run.planId;
  let workspaceId = run.workspaceId;
  if (!planId) {
    // The cap counts drafts when their plan is made.
    if ((await draftsThisMonth(ctx, deps)) >= monthlyLimit(tenant, "article_autopilot")) return { step: "sorted", error: "monthly_limit" };
    const programmes = (await forTenant(ctx, deps.db).workspaces.find({ limit: 200 })).filter((w) => !w.archivedAt);
    const chosen = settings.workspaceId ? programmes.find((w) => w.id === settings.workspaceId) : programmes.length === 1 ? programmes[0] : undefined;
    if (!chosen) return { step: "failed", error: "no_programme" };
    planId = `ap_${run.id.slice(4)}`;
    workspaceId = chosen.id;
    // Noted first, so a retry finds the same plan rather than making another.
    if (!(await notePlan(ctx, run as AutopilotRun & { leaseId: string }, planId, workspaceId, deps))) return { error: "lease_lost" };
  }
  const workspace = await workspaceOf(ctx, workspaceId!, deps);
  if (!workspace) return { step: "failed", error: "no_programme" };

  let plan = await getContentPlan(ctx, workspace.id, planId, deps.db);
  if (!plan) {
    const q = run.question;
    const asks = (run.trays?.use ?? []).map((i) => (i.kind === "also" ? `Also searched: ${i.text}` : i.text)).join("\n");
    const intake = IntakeSchema.parse({
      name: q.text.slice(0, 200),
      strategy: { objective: "brand_visibility", hubUrl: null },
      scope: { topics: [], spark: "" },
      knowledge: {},
      topology: { hubChannel: "blog", spokeChannels: settings.channels },
      blog: { primaryQuestion: q.text.slice(0, 300), buyerQuestions: asks.slice(0, 6000), subjectId: q.subjectId, questionId: q.questionId },
    });
    const fields = planFromIntake(intake);
    if (fields.blog) fields.blog = await reconcileWithSavedMap(ctx, fields.blog);
    plan = await createContentPlan(
      ctx,
      workspace.id,
      { ...fields, authoredBy: "agent", agentBrief: `autopilot:${run.id}`, autopilot: { runId: run.id, state: "working", at: new Date().toISOString() } },
      deps.db,
      { id: planId },
    );
  }
  const guard = await ours(ctx, { ...run, planId, workspaceId: workspace.id }, deps);
  if (stopped(guard)) return guard;

  // The canvas and the research, together (as Vizzy's drafts do).
  const needsGraph = plan.graph.nodes.length === 0;
  const needsResearch = !plan.blog?.researchedAt;
  const [arch] = await Promise.all([
    needsGraph ? runArchitect(ctx, { workspace, plan, deadlineMs: Math.min(opts.deadlineMs - SAVE_MS, Date.now() + 25_000) }) : Promise.resolve(null),
    needsResearch ? researchPlanBlog(ctx, { workspace, plan, timeoutMs: Math.max(5_000, Math.min(50_000, left(opts) - SAVE_MS)) }).catch(() => null) : Promise.resolve(null),
  ]);
  if (arch) {
    if (!arch.ok) return { error: "architect_failed", planId, workspaceId: workspace.id };
    await updateContentPlan(ctx, workspace.id, plan.id, { graph: arch.graph, status: "generating" }, deps.db);
  }
  const after = await getContentPlan(ctx, workspace.id, plan.id, deps.db);
  if (!after?.blog?.researchedAt) return { error: "research_failed", planId, workspaceId: workspace.id };
  return { step: "seen", planId, workspaceId: workspace.id, error: null };
};

/** What we've seen: the brand's notes that fit and aren't resting, and questions for the team. */
export const seenStep: StepFn = async (ctx, run, _opts, deps) => {
  const g = await ours(ctx, run, deps);
  if (stopped(g)) return g;
  const got = await matchPlanSeen(ctx, { workspace: g.workspace, plan: g.plan }).catch(() => null);
  // What we've seen switched off, or no answer: the article is written without notes, as by hand.
  const questions = got && got.ok ? (got.seen.questions ?? []) : [];
  return { step: "write", askedIds: questions.filter((q) => !q.answer?.trim()).map((q) => q.id) };
};

/** The article. */
export const writeStep: StepFn = async (ctx, run, opts, deps) => {
  const g = await ours(ctx, run, deps);
  if (stopped(g)) return g;
  const hub = g.plan.graph.nodes.find((n) => n.type === "hub");
  if (!hub) return { step: "failed", error: "no_hub" };
  const got = await fillPlanNode(ctx, { workspace: g.workspace, plan: g.plan, nodeId: hub.id }, { db: deps.db, deadlineMs: opts.deadlineMs - SAVE_MS });
  if (!got.ok || !got.node.body.trim()) return { error: "write_failed" };
  return { step: "check", hubHash: hashOf(got.node.body) };
};

/** The fact check. Its notes are kept only when a person approves the article. */
export const checkStep: StepFn = async (ctx, run, opts, deps) => {
  const g = await ours(ctx, run, deps);
  if (stopped(g)) return g;
  const hub = g.plan.graph.nodes.find((n) => n.type === "hub")!;
  await checkPlanBlogFacts(ctx, { workspace: g.workspace, plan: g.plan, nodeId: hub.id, timeoutMs: Math.max(5_000, Math.min(55_000, left(opts) - SAVE_MS)), keepSeen: false }).catch(() => null);
  const fresh = await getContentPlan(ctx, g.workspace.id, g.plan.id, deps.db);
  const body = fresh?.graph.nodes.find((n) => n.id === hub.id)?.body ?? "";
  const rest = (fresh ?? g.plan).graph.nodes.filter((n) => n.type !== "hub" && !n.body.trim()).map((n) => n.id);
  return { step: "nodes", hubHash: body ? hashOf(body) : run.hubHash, nodesLeft: rest };
};

/** The teaser, the promo and a post per channel, one or more per turn, then done. */
export const nodesStep: StepFn = async (ctx, run, opts, deps) => {
  const g = await ours(ctx, run, deps);
  if (stopped(g)) return g;
  const todo = [...run.nodesLeft];
  while (todo.length && left(opts) > NODE_MS + SAVE_MS) {
    const id = todo[0]!;
    const plan = (await getContentPlan(ctx, g.workspace.id, g.plan.id, deps.db)) ?? g.plan;
    const node = plan.graph.nodes.find((n) => n.id === id);
    if (node && !node.body.trim()) {
      await fillPlanNode(ctx, { workspace: g.workspace, plan, nodeId: id }, { db: deps.db, quick: true, deadlineMs: Date.now() + NODE_MS }).catch(() => null);
    }
    todo.shift();
  }
  if (todo.length) return { nodesLeft: todo };
  const fresh = await getContentPlan(ctx, g.workspace.id, g.plan.id, deps.db);
  if (fresh?.autopilot?.runId === run.id) {
    await updateContentPlan(ctx, g.workspace.id, g.plan.id, { autopilot: { runId: run.id, state: "done", at: new Date().toISOString() } }, deps.db);
  }
  return { step: "done", nodesLeft: [] };
};

/** A run that ends without finishing lets go of its plan, so the canvas saves again. */
export async function releasePlan(ctx: TenantContext, run: AutopilotRun, deps: DraftDeps = {}): Promise<void> {
  if (!run.planId || !run.workspaceId || (run.step !== "failed" && run.step !== "stopped")) return;
  const plan = await getContentPlan(ctx, run.workspaceId, run.planId, deps.db).catch(() => null);
  if (plan?.autopilot?.runId === run.id && plan.autopilot.state === "working") {
    await updateContentPlan(ctx, run.workspaceId, run.planId, { autopilot: { runId: run.id, state: "stopped", at: new Date().toISOString() } }, deps.db).catch(() => undefined);
  }
}

export const DRAFT_STEPS: Partial<Record<AutopilotRun["step"], StepFn>> = {
  pick: pickStep,
  create: createStep,
  seen: seenStep,
  write: writeStep,
  check: checkStep,
  nodes: nodesStep,
};
