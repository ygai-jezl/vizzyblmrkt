import type { TenantContext } from "@/lib/tenant/types";
import type { AutopilotRun, RunStep } from "@/lib/types/autopilot";
import { findStep, sortStep, waitingStep, type FindDeps } from "./find";
import { claimRun, finishStep, MAX_ATTEMPTS, type RunDeps, type StepPatch } from "./runs";

/**
 * Advancing a run one step. Each step reads what it needs fresh and is safe to run again, so a
 * step cut short (a tick ended, a lease ran out) just runs again from the start. A step that
 * returns an error without moving on is tried again later, until the run fails after its tries.
 */

export interface AdvanceDeps extends FindDeps, RunDeps {
  /** More steps (the draft steps, registered by the run lane). */
  steps?: Partial<Record<RunStep, StepFn>>;
  /** Called when a step ends the run without finishing (failed, stopped): lets go of its plan. */
  onEnded?: (ctx: TenantContext, run: AutopilotRun) => Promise<void>;
}

export type StepFn = (ctx: TenantContext, run: AutopilotRun, opts: { deadlineMs: number }, deps: AdvanceDeps) => Promise<StepPatch>;

/** The longest each step may take, so one starts only with time for it. */
export const STEP_MS: Partial<Record<RunStep, number>> = { find: 25_000, waiting: 25_000, sort: 40_000 };

const FIND_STEPS: Partial<Record<RunStep, StepFn>> = {
  find: (ctx, run, _o, deps) => findStep(ctx, run, deps),
  waiting: (ctx, run, _o, deps) => waitingStep(ctx, run, deps),
  sort: (ctx, run, _o, deps) => sortStep(ctx, run, deps),
};

/** How long after a failed try to try again. */
const RETRY_MS = 2 * 60_000;

/**
 * Take and do the run's next step. Null when the run isn't due, is held, or finished; otherwise the
 * run after the step.
 */
export async function advanceRun(ctx: TenantContext, id: string, opts: { deadlineMs: number }, deps: AdvanceDeps = {}): Promise<AutopilotRun | null> {
  const run = await claimRun(ctx, id, deps);
  if (!run) return null;
  const step = { ...FIND_STEPS, ...deps.steps }[run.step];
  if (!step) return finishStep(ctx, run, { step: "failed", error: `no_step_${run.step}` }, deps);
  let patch: StepPatch;
  try {
    patch = await step(ctx, run, opts, deps);
  } catch (err) {
    console.warn(`[autopilot] ${run.id} ${run.step} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    patch = { error: "step_failed" };
  }
  const now = (deps.now ?? (() => new Date()))().getTime();
  // An error that didn't move the run on: again later, or give up after the tries.
  if (patch.error && !patch.step) {
    patch = run.attempts >= MAX_ATTEMPTS ? { ...patch, step: "failed" } : { ...patch, nextAt: new Date(now + RETRY_MS).toISOString() };
  }
  const after = await finishStep(ctx, run, patch, deps);
  if (after && (after.step === "failed" || after.step === "stopped")) await deps.onEnded?.(ctx, after).catch(() => undefined);
  return after;
}
