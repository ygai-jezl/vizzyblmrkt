import { createHash, randomBytes, randomUUID } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { FINISHED_STEPS, type AutopilotRun, type RunMode, type RunStep } from "@/lib/types/autopilot";

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

/** The brand's recent runs, newest first. */
export async function recentRuns(ctx: TenantContext, limit = 20, deps: RunDeps = {}): Promise<AutopilotRun[]> {
  const rows = await repoOf(ctx, deps).find({ limit: 200 });
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
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
