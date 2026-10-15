import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BrandMapRunSchema, type BrandMapRun } from "@/lib/types/brandMapRecords";
import { freshId } from "./keys";

/**
 * A research run on a map at any size (BRAND_MAP_SCALE_ENABLED): work that takes several
 * short steps, each a model call under a minute, driven by the browser the way "Read what's
 * already there" is. Starting a run uses ONE research allowance (the budget research and
 * Vizzy's research share); its steps then carry the run's id instead of each counting
 * against the limit. A run is this brand's only, of one kind, lasts half an hour, and has a
 * fixed number of steps, so one allowance stays a bounded cost.
 */

/** Research and Vizzy's "research" share this budget, per brand. */
export const RESEARCH_LIMIT = { prefix: "brand_map_research", burstLimit: 2, hourlyLimit: 10 };

/** The most steps a run of each kind may take. */
export const RUN_STEPS: Record<BrandMapRun["kind"], number> = { situations: 30, subjects: 30, groups: 40, import: 12 };
export const RUN_MINUTES = 30;

type Deps = { db?: FirestoreLike; nowMs?: number };
export type RunResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const iso = (ms: number) => new Date(ms).toISOString();

export async function startRun(ctx: TenantContext, kind: BrandMapRun["kind"], deps: Deps = {}): Promise<RunResult<BrandMapRun>> {
  if (await isRateLimited(`tenant:${ctx.tenantId}`, RESEARCH_LIMIT, { db: deps.db })) return { ok: false, status: 429, error: "rate_limited" };
  const now = deps.nowMs ?? Date.now();
  const run = BrandMapRunSchema.parse({
    id: freshId("run"),
    tenantId: ctx.tenantId,
    kind,
    startedAt: iso(now),
    startedBy: ctx.userId ?? null,
    expiresAt: iso(now + RUN_MINUTES * 60_000),
    stepsLeft: RUN_STEPS[kind],
  });
  const { id, tenantId: _t, ...data } = run;
  void _t;
  await brandMapRecords(ctx, deps.db).create("run", id, data);
  return { ok: true, value: run };
}

const REFUSED: Record<string, number> = { no_run: 404, wrong_run: 400, run_expired: 410, run_used_up: 429 };

/** Take one step of a run: refused when it isn't this brand's, is of another kind, has ended, or has no steps left. */
export async function takeStep(ctx: TenantContext, runId: string, kind: BrandMapRun["kind"], deps: Deps = {}): Promise<RunResult<{ stepsLeft: number }>> {
  const now = deps.nowMs ?? Date.now();
  const seen = { error: "no_run" };
  const done = await brandMapRecords(ctx, deps.db)
    .claim("run", runId, (cur) => {
      const run = BrandMapRunSchema.safeParse(cur);
      if (!run.success) return null;
      if (run.data.kind !== kind) seen.error = "wrong_run";
      else if (Date.parse(run.data.expiresAt) <= now) seen.error = "run_expired";
      else if (run.data.stepsLeft <= 0) seen.error = "run_used_up";
      else return { stepsLeft: run.data.stepsLeft - 1 };
      return null;
    })
    .catch(() => null);
  if (!done) return { ok: false, status: REFUSED[seen.error] ?? 404, error: seen.error };
  return { ok: true, value: { stepsLeft: Number(done.stepsLeft ?? 0) } };
}
