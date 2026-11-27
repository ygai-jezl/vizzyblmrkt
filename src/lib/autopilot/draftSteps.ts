import { createHash } from "node:crypto";
import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { startReview } from "@/lib/content/blog/refreshReview";
import { mayStartReview } from "@/lib/content/blog/refreshGate";
import { autopilotHolds } from "./planLock";
import { usageMeter } from "@/lib/plans/meter";
import { reconcileWithSavedMap } from "@/lib/content/blog/mapActions";
import { checkPlanBlogFacts, matchPlanSeen, researchPlanBlog } from "@/lib/content/blog/hubActions";
import { runArchitect } from "@/lib/content/create/architectRun";
import { fillPlanNode } from "@/lib/content/create/fillPlan";
import { IntakeSchema, planFromIntake } from "@/lib/content/create/intake";
import { dropPick, pickNextUp, readNextUp } from "@/lib/nextUp/pick";
import { slotQuestionsFor } from "@/lib/contentStrategy/nextUp";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { monthlyLimit } from "@/lib/plans/limits";
import { forTenant, getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { createContentPlan, getContentPlan, updateContentPlan } from "@/lib/tenant/workspaceContent";
import { AutopilotSettingsSchema, type AutopilotRun, type NextUpPick } from "@/lib/types/autopilot";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import type { Workspace } from "@/lib/types/workspace";
import type { AdvanceDeps, StepFn } from "./advance";
import { draftsThisMonth, heldQuestionIds, notePlan, type StepPatch } from "./runs";
import { recordPlanDraft } from "@/lib/agentRecord/drafts";
import { isStrategyResultsEnabled } from "@/lib/brandStrategy/flags";

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

/**
 * A refresh pick, taken by a Draft run (BLOG_REFRESH_ENABLED): the review starts on the live article
 * and the run is done. The review stops at proposals for a person; nothing is ever applied. Null
 * when it can't be taken now (no grant or reviews left, the article held or gone), so the run
 * takes the next pick instead.
 */
async function takeRefresh(ctx: TenantContext, pick: NextUpPick, deps: DraftDeps): Promise<StepPatch | null> {
  if (!pick.planId || !pick.workspaceId) return null;
  if (!(await mayStartReview(ctx, { db: deps.db, now: deps.now, loadTenant: deps.loadTenant }).then((m) => m.ok).catch(() => false))) return null;
  const plan = await getContentPlan(ctx, pick.workspaceId, pick.planId, deps.db).catch(() => null);
  if (!plan || autopilotHolds(plan)) return null;
  const started = await startReview(ctx, { plan, by: "autopilot" }, { db: deps.db, now: deps.now }).catch(() => null);
  if (!started?.ok || !started.started) return null;
  await dropPick(ctx, pick.questionId, deps);
  return {
    step: "done",
    refreshOf: plan.id,
    workspaceId: plan.workspaceId,
    question: { questionId: pick.questionId, text: pick.question, subjectId: pick.subjectId, subjectName: pick.subjectName },
    ...fromPick(pick),
  };
}

/**
 * A pick close to a live article (NEXT_UP_REPEATS_ENABLED), taken by a Draft run: a refresh review
 * of that article starts, carrying the question, and the run is done. It is never drafted as a new
 * article. Null when it can't be added now, so the run passes over it and a person decides.
 */
async function takeClose(ctx: TenantContext, pick: NextUpPick, deps: DraftDeps): Promise<StepPatch | null> {
  const to = pick.closeTo;
  if (!to?.planId || !to.workspaceId) return null;
  if (!(await mayStartReview(ctx, { db: deps.db, now: deps.now, loadTenant: deps.loadTenant }).then((m) => m.ok).catch(() => false))) return null;
  const plan = await getContentPlan(ctx, to.workspaceId, to.planId, deps.db).catch(() => null);
  if (!plan || autopilotHolds(plan)) return null;
  const started = await startReview(ctx, { plan, by: "autopilot", question: { id: pick.questionId, text: pick.question } }, { db: deps.db, now: deps.now }).catch(() => null);
  if (!started?.ok || !started.started) return null;
  await dropPick(ctx, pick.questionId, deps);
  return {
    step: "done",
    refreshOf: plan.id,
    workspaceId: plan.workspaceId,
    question: { questionId: pick.questionId, text: pick.question, subjectId: pick.subjectId, subjectName: pick.subjectName },
    ...fromPick(pick),
  };
}

/** What a run keeps of the pick it took: the strategy and plan it came from (STRATEGY_RESULTS_ENABLED). */
const fromPick = (pick: NextUpPick): { basedOn?: AutopilotRun["basedOn"] } => (isStrategyResultsEnabled() && pick.basedOn ? { basedOn: pick.basedOn } : {});

/** A scheduled run takes Next up's best pick no other run has (choosing again when Next up is old). */
export const pickStep: StepFn = async (ctx, run, opts, deps: DraftDeps) => {
  if (run.question) return { step: "find" };
  // Every question a run took lately (going, sorted or written), so several runs a week never repeat one.
  const others = await heldQuestionIds(ctx, deps);
  let doc = await readNextUp(ctx, deps);
  const now = (deps.now ?? (() => new Date()))().getTime();
  // A refresh pick (BLOG_FRESHNESS_ENABLED) is a Draft run's to take once reviews are on (BLOG_REFRESH_ENABLED);
  // otherwise it waits for a person, and the run writes something new.
  const refreshes = run.mode === "draft" && isBlogRefreshEnabled();
  // A combine pick (CONTENT_STRATEGY_NEXT_UP_ENABLED) is never drafted: it waits for a person, like a close pick.
  const writable = (p: { questionId: string; kind?: string }) => p.kind !== "combine" && (p.kind !== "refresh" || refreshes) && !others.includes(p.questionId);
  if (!doc || !doc.picks.some(writable) || now - Date.parse(doc.at) > STALE_PICKS_MS) {
    const got = await pickNextUp(ctx, { by: "schedule", deadlineMs: opts.deadlineMs - 5_000 }, {
      db: deps.db,
      loadTenant: (deps as DraftDeps).loadTenant,
      activeQuestionIds: async () => others,
      ...(deps.search ? { search: deps.search } : {}),
    });
    doc = got.ok ? got.doc : doc;
  }
  // In Next up's order: a refresh pick that can't be taken now is passed over, never dropped.
  let pick: NextUpPick | undefined;
  for (const p of (doc?.picks ?? []).filter(writable)) {
    // Close to a live article: added to it by a Draft run when it can be, otherwise left for a person.
    if (p.closeTo) {
      const added = refreshes ? await takeClose(ctx, p, deps) : null;
      if (added) return added;
      continue;
    }
    if (p.kind !== "refresh") {
      pick = p;
      break;
    }
    const taken = await takeRefresh(ctx, p, deps);
    if (taken) return taken;
  }
  if (!pick) return { step: "stopped", error: "nothing_to_pick" };
  await dropPick(ctx, pick.questionId, deps);
  return { step: "find", question: { questionId: pick.questionId, text: pick.question, subjectId: pick.subjectId, subjectName: pick.subjectName }, ...fromPick(pick) };
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
    // Research needs Google: at the month's web search cap the run stops sorted, like at the draft cap.
    if (await usageMeter(ctx, "web_searches", "autopilot_research", { tenant, db: deps.db }).check()) return { step: "sorted", error: "search_limit" };
    const programmes = (await forTenant(ctx, deps.db).workspaces.find({ limit: 200 })).filter((w) => !w.archivedAt);
    const chosen = settings.workspaceId ? programmes.find((w) => w.id === settings.workspaceId) : programmes.length === 1 ? programmes[0] : undefined;
    if (!chosen) return { step: "failed", error: "no_programme" };
    planId = `ap_${run.id.slice(4)}`;
    workspaceId = chosen.id;
    // Noted first, so a retry finds the same plan rather than making another.
    if (!(await notePlan(ctx, run as AutopilotRun & { leaseId: string }, planId, workspaceId, deps))) return { error: "lease_lost" };
    // Counted once, where the old counter counts it (a retry finds the plan noted and skips this).
    await usageMeter(ctx, "autopilot_drafts", "autopilot", { tenant, db: deps.db }).record(1);
  }
  const workspace = await workspaceOf(ctx, workspaceId!, deps);
  if (!workspace) return { step: "failed", error: "no_programme" };

  let plan = await getContentPlan(ctx, workspace.id, planId, deps.db);
  if (!plan) {
    const q = run.question;
    // Written for a slot of the approved content plan: the slot's other questions go in the brief too.
    const slotAsks = await slotQuestionsFor(ctx, q.questionId, { db: deps.db }).catch(() => [] as string[]);
    const asks = [...slotAsks, ...(run.trays?.use ?? []).map((i) => (i.kind === "also" ? `Also searched: ${i.text}` : i.text))].join("\n");
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
    // The brief says which strategy and plan the article came from, as the run does.
    if (fields.blog && run.basedOn && isStrategyResultsEnabled()) fields.blog = { ...fields.blog, basedOn: run.basedOn };
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
    needsResearch ? researchPlanBlog(ctx, { workspace, plan, timeoutMs: Math.max(5_000, Math.min(50_000, left(opts) - SAVE_MS)), searchPurpose: "autopilot_research" }).catch(() => null) : Promise.resolve(null),
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
    // The agent record: the autopilot's draft, as it finished it (soft, never fails the step).
    await recordPlanDraft(ctx, g.workspace.id, fresh, "autopilot", { db: deps.db });
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
