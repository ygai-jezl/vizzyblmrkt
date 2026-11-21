import { createHash } from "node:crypto";
import { listNotes } from "@/lib/brandNotes/store";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { getContentPlan, updateContentPlan } from "@/lib/tenant/workspaceContent";
import type { AutopilotRun } from "@/lib/types/autopilot";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { recentRuns } from "./runs";

/**
 * What we've seen, with nobody there: a draft asks the team up to three questions. When every one
 * is answered, the draft gets the answers: if nobody has changed the article since autopilot wrote
 * it, the run goes again from What we've seen (Look again, rewrite, fact check); if someone has,
 * nothing is overwritten and Review says the answers are in, to press Look again.
 */

export interface AnswersDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Review shows a draft's question rows this long (src/lib/review/summary.ts). */
const ROWS_MS = 14 * 86_400_000;
/** Ticks between looks for drafts done with by some other way (every 2 minutes, so once an hour). */
const SWEEP_TICKS = 30;
const TICK_MS = 120_000;

/** A draft nobody needs answers for any more: gone, archived, approved or live. */
export function draftDoneWith(plan: Pick<ContentPlan, "status" | "graph"> | null): boolean {
  if (!plan || plan.status === "archived") return true;
  const hub = plan.graph.nodes.find((n) => n.type === "hub");
  return hub?.status === "approved" || Boolean(hub?.blog?.live);
}

/**
 * A draft that's done with (approved, found live, archived or deleted): its question rows in Review
 * close. The questions themselves stay open in What we've seen, for later articles.
 */
export async function closeDraftRows(ctx: TenantContext, plan: Pick<ContentPlan, "autopilot"> | null, deps: AnswersDeps = {}): Promise<boolean> {
  const runId = plan?.autopilot?.runId;
  if (!runId) return false;
  try {
    const repo = forTenant(ctx, deps.db).autopilotRuns;
    const run = await repo.getById(runId);
    if (!run || (!run.askedIds.length && !run.answersIn)) return false;
    await repo.update(runId, { askedIds: [], answersIn: false });
    return true;
  } catch (err) {
    console.warn("[autopilot] closing a draft's rows failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return false;
  }
}

/**
 * Once an hour, close the rows of drafts done with some other way than the routes that close them
 * as they go (an approval from before this, or a plan gone some other way).
 */
async function closeDoneWith(ctx: TenantContext, runs: AutopilotRun[], deps: AnswersDeps): Promise<number> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  if (Math.floor(nowMs / TICK_MS) % SWEEP_TICKS !== 0) return 0;
  let closed = 0;
  for (const run of runs) {
    if (run.mode !== "draft" || run.step !== "done" || !run.planId || !run.workspaceId) continue;
    if ((!run.askedIds.length && !run.answersIn) || nowMs - Date.parse(run.updatedAt) > ROWS_MS) continue;
    const plan = await getContentPlan(ctx, run.workspaceId, run.planId, deps.db).catch(() => undefined);
    if (plan === undefined || !draftDoneWith(plan)) continue;
    await forTenant(ctx, deps.db).autopilotRuns.update(run.id, { askedIds: [], answersIn: false });
    run.askedIds = [];
    run.answersIn = false;
    closed += 1;
  }
  return closed;
}

/** Done drafts whose team questions are all answered: rewritten, or flagged. Returns how many moved. */
export async function takeAnswers(ctx: TenantContext, deps: AnswersDeps = {}): Promise<number> {
  const runs = await recentRuns(ctx, 60, deps);
  await closeDoneWith(ctx, runs, deps).catch(() => 0);
  const waiting = runs.filter((r) => r.mode === "draft" && r.step === "done" && r.askedIds.length && r.planId && r.workspaceId);
  if (!waiting.length) return 0;
  const notes = new Map((await listNotes(ctx, { db: deps.db })).map((n) => [n.id, n] as const));
  let moved = 0;
  for (const run of waiting) {
    const open = run.askedIds.filter((id) => notes.get(id)?.status === "asked");
    if (open.length === run.askedIds.length) continue;
    if (open.length) {
      // Some answered: keep only the ones still waiting.
      await forTenant(ctx, deps.db).autopilotRuns.update(run.id, { askedIds: open });
      continue;
    }
    moved += await rewriteOrFlag(ctx, run, deps);
  }
  return moved;
}

async function rewriteOrFlag(ctx: TenantContext, run: AutopilotRun, deps: AnswersDeps): Promise<number> {
  const repo = forTenant(ctx, deps.db).autopilotRuns;
  const plan = await getContentPlan(ctx, run.workspaceId!, run.planId!, deps.db);
  const hub = plan?.graph.nodes.find((n) => n.type === "hub");
  const at = (deps.now ?? (() => new Date()))().toISOString();
  // Approved or live already: nothing to rewrite and nothing to tell (the answers wait in What we've seen).
  if (draftDoneWith(plan)) {
    await repo.update(run.id, { askedIds: [], answersIn: false, updatedAt: at });
    return 1;
  }
  const untouched = Boolean(plan && hub && hub.status !== "approved" && plan.autopilot?.runId === run.id && plan.autopilot.state === "done" && hashOf(hub.body) === run.hubHash);
  if (!untouched) {
    await repo.update(run.id, { askedIds: [], answersIn: true, updatedAt: at });
    return 1;
  }
  // Lock it again and go round from What we've seen.
  await updateContentPlan(ctx, run.workspaceId!, run.planId!, { autopilot: { runId: run.id, state: "working", at } }, deps.db);
  await repo.update(run.id, { step: "seen", active: true, askedIds: [], nextAt: at, attempts: 0, error: null, updatedAt: at });
  return 1;
}
