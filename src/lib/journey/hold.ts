import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Journey } from "@/lib/types/journey";

/**
 * Held waitlist journey steps (engine move D1). While a journey is paused or its
 * launch archived, the worker parks each person's due step as "held" instead of
 * ending their sequence (see processJourneyStepJob). Turning the journey back on
 * releases them here.
 */

/**
 * People held longer than this leave the journey on resume rather than get
 * months-old emails (owner decision, 24 Sept 2026).
 */
export const HOLD_MAX_AGE_DAYS = 90;
/**
 * Released steps go out at most this many per worker tick (the email cron runs
 * every 2 minutes and drains 100 per tenant), so a big resume can't crowd out
 * the tenant's broadcasts and invites.
 */
export const RELEASE_PER_TICK = 100;
const TICK_MS = 2 * 60_000;
const DAY = 86_400_000;

export interface ReleaseSummary {
  /** Back in the queue; each gets their next email. */
  released: number;
  /** Held longer than HOLD_MAX_AGE_DAYS: left the journey. */
  expired: number;
  /** Their step was removed while paused: left the journey. */
  stepRemoved: number;
}

/** Release a journey's held steps. Idempotent: a second run finds nothing held. */
export async function releaseHeldJourneySteps(
  ctx: TenantContext,
  journey: Journey,
  opts: { now?: number; db?: FirestoreLike } = {},
): Promise<ReleaseSummary> {
  const now = opts.now ?? Date.now();
  const repo = forTenant(ctx, opts.db);
  const held = (
    await repo.emailJobs.find({
      where: [
        ["campaignId", "==", journey.campaignId],
        ["status", "==", "held"],
      ],
    })
  )
    .filter((j) => j.type === "journey_step" && String(j.payload.journeyId ?? "") === journey.id)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  const steps = new Set(journey.graph.nodes.map((n) => n.id));
  const stamp = new Date(now).toISOString();
  const summary: ReleaseSummary = { released: 0, expired: 0, stepRemoved: 0 };
  let dueSlot = 0;

  for (const job of held) {
    if (job.heldAt && now - Date.parse(job.heldAt) > HOLD_MAX_AGE_DAYS * DAY) {
      await repo.emailJobs.update(job.id, { status: "done", endedReason: "hold_expired", processedAt: stamp });
      summary.expired += 1;
      continue;
    }
    if (!steps.has(String(job.payload.nodeId ?? ""))) {
      await repo.emailJobs.update(job.id, { status: "done", endedReason: "step_removed", processedAt: stamp });
      summary.stepRemoved += 1;
      continue;
    }
    // Already due (the usual case): spread across worker ticks, oldest first.
    // Not yet due: keeps its own time.
    const due = Date.parse(job.scheduledAt) <= now;
    const scheduledAt = due
      ? new Date(now + Math.floor(dueSlot++ / RELEASE_PER_TICK) * TICK_MS).toISOString()
      : job.scheduledAt;
    await repo.emailJobs.update(job.id, {
      status: "pending",
      scheduledAt,
      heldReason: null,
      heldAt: null,
      claimedAt: null,
    });
    summary.released += 1;
  }
  return summary;
}

/** How many people are waiting in a launch's paused journey (equality-only count). */
export async function countHeldJourneySteps(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<number> {
  return forTenant(ctx, db).emailJobs.count([
    ["campaignId", "==", campaignId],
    ["type", "==", "journey_step"],
    ["status", "==", "held"],
  ]);
}
