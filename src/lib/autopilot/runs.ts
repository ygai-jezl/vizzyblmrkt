import { createHash, randomBytes, randomUUID } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { FINISHED_STEPS, MAX_PER_WEEK, type AutopilotRun, type RunMode, type RunStep } from "@/lib/types/autopilot";

/**
 * Autopilot runs (`autopilot_runs`): one question found, sorted and, in Draft mode, written. A run
 * advances one step at a time under a lease: a step is taken with `claimRun` (only when due and not
 * held) and saved with `finishStep` (only while this run still holds the lease and the step hasn't
 * moved on), so two ticks, or a tick and a page, never do the same step at once, and a late step
 * never writes over a newer one. Queries here are one equality (beside the brand), so no index.
 */

export interface RunDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

/** Longer than any one step can take (every model call in a step has its own deadline). */
export const RUN_LEASE_MS = 4 * 60_000;
/** Tries at one step before the run fails. */
export const MAX_ATTEMPTS = 3;

const repoOf = (ctx: TenantContext, deps: RunDeps) => forTenant(ctx, deps.db).autopilotRuns;
const nowOf = (deps: RunDeps) => (deps.now ?? (() => new Date()))();
export const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/** A scheduled run's id: one per brand, week and slot, so a retried tick finds the same run. */
export function scheduledRunId(tenantId: string, week: string, slot: number): string {
  return `run_${createHash("sha256").update(`${tenantId}\n${week}\n${slot}`).digest("hex").slice(0, 24)}`;
}

export const freshRunId = () => `run_${randomBytes(12).toString("hex")}`;

export interface NewRun {
  id: string;
  mode: RunMode;
  trigger: AutopilotRun["trigger"];
  step: RunStep;
  question: AutopilotRun["question"];
  workspaceId?: string | null;
  /** The strategy and plan of the pick it starts from (STRATEGY_RESULTS_ENABLED). */
  basedOn?: AutopilotRun["basedOn"];
}

/** Start a run, or find it when this id was started already. */
export async function createRun(ctx: TenantContext, input: NewRun, deps: RunDeps = {}): Promise<AutopilotRun> {
  const now = nowOf(deps);
  const at = now.toISOString();
  const fields = {
    mode: input.mode,
    trigger: input.trigger,
    step: input.step,
    active: !FINISHED_STEPS.has(input.step),
    question: input.question,
    signalId: null,
    googleSkipped: null,
    trays: null,
    workspaceId: input.workspaceId ?? null,
    planId: null,
    nodesLeft: [],
    hubHash: null,
    askedIds: [],
    month: monthOf(now),
    nextAt: at,
    leaseId: null,
    leaseUntil: null,
    attempts: 0,
    error: null,
    by: input.trigger === "person" ? (ctx.userId ?? null) : null,
    createdAt: at,
    updatedAt: at,
    ...(input.basedOn ? { basedOn: input.basedOn } : {}),
  };
  const { doc } = await repoOf(ctx, deps).upsert(input.id, () => fields, () => null);
  return doc;
}

export async function getRun(ctx: TenantContext, id: string, deps: RunDeps = {}): Promise<AutopilotRun | null> {
  return repoOf(ctx, deps).getById(id);
}

/** The brand's runs still going, newest first. */
export async function activeRuns(ctx: TenantContext, deps: RunDeps = {}): Promise<AutopilotRun[]> {
  const rows = await repoOf(ctx, deps).find({ where: [["active", "==", true]], limit: 50 });
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The brand's recent runs (this month and last), newest first. */
export async function recentRuns(ctx: TenantContext, limit = 20, deps: RunDeps = {}): Promise<AutopilotRun[]> {
  const now = nowOf(deps);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const repo = repoOf(ctx, deps);
  // One equality each (beside the brand), so no index, and never an unordered cut of every run.
  const [these, before] = await Promise.all([
    repo.find({ where: [["month", "==", monthOf(now)]], limit: 500 }),
    repo.find({ where: [["month", "==", monthOf(last)]], limit: 500 }),
  ]);
  return [...these, ...before].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** How long a question a run took stays out of Next up's picks. */
export const HOLD_DAYS = 30;
/** How long a sorted, unwritten question shows as ready to write. */
export const READY_DAYS = 7;

/**
 * Questions runs have taken lately: going, sorted, written or stopped in the last 30 days (not
 * failed), so a brand running several a week never gets the same question twice.
 */
export async function heldQuestionIds(ctx: TenantContext, deps: RunDeps = {}): Promise<string[]> {
  const since = nowOf(deps).getTime() - HOLD_DAYS * 86_400_000;
  const [recent, going] = await Promise.all([recentRuns(ctx, 1000, deps), activeRuns(ctx, deps)]);
  const held = [...going, ...recent.filter((r) => r.step !== "failed" && Date.parse(r.createdAt) >= since)];
  return [...new Set(held.flatMap((r) => (r.question ? [r.question.questionId] : [])))];
}

/** Scheduled runs sorted and waiting for a person to write them (Suggest, or Draft past its cap), newest first. */
export function readyToWrite(runs: AutopilotRun[], nowMs: number, limit = MAX_PER_WEEK): AutopilotRun[] {
  return runs
    .filter((r) => r.trigger === "schedule" && r.step === "sorted" && r.question && nowMs - Date.parse(r.updatedAt) < READY_DAYS * 86_400_000)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** Drafts written this month (counted when the plan is made), against the article_autopilot cap. */
export async function draftsThisMonth(ctx: TenantContext, deps: RunDeps = {}): Promise<number> {
  const rows = await repoOf(ctx, deps).find({ where: [["month", "==", monthOf(nowOf(deps))]], limit: 500 });
  return rows.filter((r) => r.mode === "draft" && r.planId).length;
}

/** Take a run's next step: only while it is going, due, and not held by another run of the lane. */
export async function claimRun(ctx: TenantContext, id: string, deps: RunDeps = {}): Promise<(AutopilotRun & { leaseId: string }) | null> {
  const now = nowOf(deps).getTime();
  const leaseId = randomUUID();
  const got = await repoOf(ctx, deps).claim(id, (cur) => {
    const free = cur.active && Date.parse(cur.nextAt) <= now && (!cur.leaseUntil || Date.parse(cur.leaseUntil) <= now);
    return free ? { leaseId, leaseUntil: new Date(now + RUN_LEASE_MS).toISOString(), attempts: cur.attempts + 1 } : null;
  });
  return got ? { ...got, leaseId } : null;
}

export type StepPatch = Partial<Omit<AutopilotRun, "id" | "tenantId" | "leaseId" | "leaseUntil" | "createdAt">>;

/**
 * Save what a step did and let go of the lease, only if this run still holds it at the same step.
 * Moving to a new step resets the attempts.
 */
export async function finishStep(ctx: TenantContext, run: { id: string; leaseId: string; step: RunStep }, patch: StepPatch, deps: RunDeps = {}): Promise<AutopilotRun | null> {
  const at = nowOf(deps).toISOString();
  return repoOf(ctx, deps).claim(run.id, (cur) => {
    if (cur.leaseId !== run.leaseId || cur.step !== run.step) return null;
    const step = patch.step ?? cur.step;
    return {
      ...patch,
      ...(patch.step && patch.step !== cur.step ? { attempts: 0 } : {}),
      active: !FINISHED_STEPS.has(step),
      leaseId: null,
      leaseUntil: null,
      updatedAt: at,
    };
  });
}

/** Stop a run (a person took over). Only a run still going. */
export async function stopRun(ctx: TenantContext, id: string, reason: string, deps: RunDeps = {}): Promise<AutopilotRun | null> {
  const at = nowOf(deps).toISOString();
  return repoOf(ctx, deps).claim(id, (cur) => (cur.active ? { step: "stopped", active: false, error: reason.slice(0, 80), leaseId: null, leaseUntil: null, updatedAt: at } : null));
}

/** Change a finished run's trays (a person moved an item). */
export async function updateTrays(ctx: TenantContext, id: string, trays: NonNullable<AutopilotRun["trays"]>, deps: RunDeps = {}): Promise<AutopilotRun | null> {
  const at = nowOf(deps).toISOString();
  return repoOf(ctx, deps).claim(id, (cur) => (cur.trays ? { trays, updatedAt: at } : null));
}

/** Note the plan a run is about to make, before making it, while this run holds the lease. */
export async function notePlan(ctx: TenantContext, run: { id: string; leaseId: string }, planId: string, workspaceId: string, deps: RunDeps = {}): Promise<boolean> {
  const got = await repoOf(ctx, deps).claim(run.id, (cur) => (cur.leaseId === run.leaseId ? { planId, workspaceId, updatedAt: nowOf(deps).toISOString() } : null));
  return Boolean(got);
}
