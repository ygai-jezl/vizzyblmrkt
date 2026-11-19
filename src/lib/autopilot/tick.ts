import { tenantMayUse } from "@/lib/plans/brandAccess";
import { listAllTenants } from "@/lib/tenant/registry";
import type { TenantContext } from "@/lib/tenant/types";
import { AutopilotSettingsSchema } from "@/lib/types/autopilot";
import type { Tenant } from "@/lib/types/tenant";
import { advanceRun, STEP_MS } from "./advance";
import { DRAFT_STEP_MS, DRAFT_STEPS, releasePlan, type DraftDeps } from "./draftSteps";
import { isAutopilotEnabled } from "./flags";
import { activeRuns, createRun, getRun, scheduledRunId } from "./runs";
import { takeAnswers } from "./answers";

/**
 * The autopilot lane of the lifecycle tick (every 2 minutes, CREATE_ARTICLE_AUTOPILOT_ENABLED). On
 * a brand's chosen weekday it starts that week's runs (one at a time: a brand never has two going),
 * and each tick it moves at most two runs on by one step, only when there's time for that step.
 */

export interface AutopilotTickDeps extends DraftDeps {
  listTenants?: () => Promise<Tenant[]>;
  clock?: () => number;
}

export interface AutopilotTickResult {
  tenants: number;
  started: number;
  advanced: number;
}

const STEPS_PER_TICK = 2;
const TICK_MS = 120_000;
const DEFAULT_STEP_MS = 30_000;

/** "2026-W47": the ISO week a date falls in. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** 1 (Monday) to 7 (Sunday), in UTC. */
export const isoWeekday = (d: Date) => d.getUTCDay() || 7;

/** Start this week's next run for a brand when it's the day, none is going, and the week isn't done. */
async function startRun(ctx: TenantContext, t: Tenant, now: Date, deps: AutopilotTickDeps): Promise<boolean> {
  const settings = AutopilotSettingsSchema.parse(t.autopilot ?? {});
  if (settings.mode === "off" || isoWeekday(now) !== settings.weekday) return false;
  if ((await activeRuns(ctx, deps)).some((r) => r.trigger === "schedule")) return false;
  const week = isoWeek(now);
  for (let slot = 0; slot < settings.perWeek; slot += 1) {
    const id = scheduledRunId(t.id, week, slot);
    if (await getRun(ctx, id, deps)) continue;
    const mode = settings.mode === "draft" && tenantMayUse(t, "article_autopilot") ? "draft" : "suggest";
    await createRun(ctx, { id, mode, trigger: "schedule", step: "pick", question: null }, deps);
    return true;
  }
  return false;
}

export async function runAutopilot(opts: { deadlineMs: number }, deps: AutopilotTickDeps = {}): Promise<AutopilotTickResult> {
  const result: AutopilotTickResult = { tenants: 0, started: 0, advanced: 0 };
  if (!isAutopilotEnabled()) return result;
  const clock = deps.clock ?? Date.now;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter(
    (t) => tenantMayUse(t, "next_up") && AutopilotSettingsSchema.parse(t.autopilot ?? {}).mode !== "off",
  );
  const offset = tenants.length ? Math.floor(clock() / TICK_MS) % tenants.length : 0;
  const order = [...tenants.slice(offset), ...tenants.slice(0, offset)];
  const stepDeps: DraftDeps = { ...deps, now: () => new Date(clock()), steps: DRAFT_STEPS, onEnded: (c, r) => releasePlan(c, r, deps) };
  for (const t of order) {
    if (result.advanced >= STEPS_PER_TICK || opts.deadlineMs - clock() < DEFAULT_STEP_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      result.tenants += 1;
      if (await startRun(ctx, t, new Date(clock()), deps)) result.started += 1;
      // Team answers to a draft's questions: the draft goes round again, or Review says they're in.
      await takeAnswers(ctx, { db: deps.db, now: () => new Date(clock()) }).catch(() => 0);
      for (const run of await activeRuns(ctx, deps)) {
        if (result.advanced >= STEPS_PER_TICK) break;
        const needs = STEP_MS[run.step] ?? DRAFT_STEP_MS[run.step] ?? DEFAULT_STEP_MS;
        if (opts.deadlineMs - clock() < needs || Date.parse(run.nextAt) > clock()) continue;
        if (await advanceRun(ctx, run.id, { deadlineMs: opts.deadlineMs }, stepDeps)) result.advanced += 1;
      }
    } catch (err) {
      console.warn(`[autopilot] ${t.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return result;
}
