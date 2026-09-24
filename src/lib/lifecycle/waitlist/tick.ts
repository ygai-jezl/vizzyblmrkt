import { forTenant, type TenantContext } from "@/lib/tenant";
import { versionDocId } from "../enrol";
import { backfillWaitlistJourney } from "./enrol";
import { reconcileWaitlistDrains } from "./engineSwitch";
import { isWaitlistEngineEnabled } from "./flags";
import { drainWaitlistTenant, type WaitlistDrainResult, type WaitlistRunnerDeps } from "./runner";

/**
 * One tenant's share of the lifecycle tick for waitlist journeys (engine move):
 * send what's due, carry on any first-publish backfill, and retire moved
 * launches' original journeys once nobody is left on them. Nothing runs while
 * the engine's kill switch is off.
 */

export interface WaitlistTickResult extends WaitlistDrainResult {
  /** People enrolled by resumed backfills. */
  backfilled: number;
  /** Original journeys retired after draining. */
  retired: number;
}

const BUDGET_MS = 80_000;

export async function runWaitlistTick(
  ctx: TenantContext,
  deps: WaitlistRunnerDeps = {},
  deadlineAt?: number,
): Promise<WaitlistTickResult> {
  if (!isWaitlistEngineEnabled()) return { due: 0, outcomes: {}, deferred: 0, backfilled: 0, retired: 0 };
  const clock = deps.now ?? Date.now;
  const deadline = deadlineAt ?? clock() + (deps.budgetMs ?? BUDGET_MS);
  const drained = await drainWaitlistTenant(ctx, deps, deadline);
  const warn = (what: string) => (err: unknown) => {
    console.warn(`[lifecycle] waitlist ${what} ${ctx.tenantId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
  };
  let backfilled = 0;
  if (clock() < deadline) {
    backfilled = await continueBackfills(ctx, deps, deadline).catch((err) => (warn("backfill")(err), 0));
  }
  let retired = 0;
  if (clock() < deadline) {
    retired = (await reconcileWaitlistDrains(ctx, { db: deps.db, nowMs: clock() }).catch((err) => (warn("drain")(err), { retired: 0 }))).retired;
  }
  return { ...drained, backfilled, retired };
}

async function continueBackfills(ctx: TenantContext, deps: WaitlistRunnerDeps, deadline: number): Promise<number> {
  const clock = deps.now ?? Date.now;
  const repo = forTenant(ctx, deps.db);
  const running = (await repo.lifecycleJourneys.find({ where: [["connectionId", "==", ""]], limit: 200 })).filter(
    (j) => j.backfill?.status === "running" && j.publishedVersion !== null && j.audience?.kind === "waitlist",
  );
  let enrolled = 0;
  for (const j of running) {
    if (clock() >= deadline || j.audience?.kind !== "waitlist") break;
    const [version, campaign] = await Promise.all([
      repo.lifecycleVersions.getById(versionDocId(j.id, j.publishedVersion!)),
      repo.campaigns.getById(j.audience.campaignId),
    ]);
    if (!version || !campaign) continue;
    enrolled += (await backfillWaitlistJourney(ctx, { journey: j, version, campaign }, { db: deps.db, now: clock, deadlineAt: deadline })).enrolled;
  }
  return enrolled;
}
