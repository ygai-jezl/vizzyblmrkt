import type { TenantContext } from "@/lib/tenant";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Journey, JourneyGraph, JourneyStatus } from "@/lib/types/journey";
import {
  activateJourney,
  processEmailJobs,
  validateJourneyGraph,
} from "@/lib/email/delivery";
import { releaseHeldJourneySteps, type ReleaseSummary } from "./hold";
import { setLifecycleJourneyStatus } from "@/lib/lifecycle/service";
import { waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import type { WaitlistReleaseSummary } from "@/lib/lifecycle/waitlist/enrol";

/**
 * Journey persistence service — the single source of truth for saving and
 * state-changing a launch's journey. Both the admin HTTP routes (human canvas)
 * and the agent canvas endpoint (Campaign Ops Agent) call these, so the
 * validation + upsert + activation semantics can never drift between them.
 *
 * The deterministic `journey_${campaignId}` id means one journey per launch:
 * re-saving updates the same doc.
 */

/** Deterministic one-journey-per-launch id. */
export function journeyIdFor(campaignId: string): string {
  return `journey_${campaignId}`;
}

export type UpsertJourneyResult =
  | { ok: true; journey: Journey }
  | { ok: false; error: "campaign_not_found" | "journey_active" };

/**
 * Upsert the journey graph (draft autosave). Preserves `createdAt` + the
 * existing status unless `status` is given.
 *
 * `refuseIfActive` is the agent guard: the autonomous path must never silently
 * rewrite a LIVE journey's graph (it would change what future sends deliver) —
 * the operator has to pause it first. The human PUT path leaves this off, so
 * operators can keep editing their own active journey as before.
 */
export async function upsertJourneyDraft(
  ctx: TenantContext,
  campaignId: string,
  graph: JourneyGraph,
  opts: { status?: JourneyStatus; refuseIfActive?: boolean } = {},
): Promise<UpsertJourneyResult> {
  const repo = forTenant(ctx);
  const id = journeyIdFor(campaignId);
  const now = new Date().toISOString();

  const existing = await repo.journeys.getById(id);
  if (existing) {
    if (opts.refuseIfActive && existing.status === "active") {
      return { ok: false, error: "journey_active" };
    }
    await repo.journeys.update(id, {
      graph,
      status: opts.status ?? existing.status,
      updatedAt: now,
    });
  } else {
    // A journey can only exist for a real launch in this tenant.
    const campaign = await repo.campaigns.getById(campaignId);
    if (!campaign) return { ok: false, error: "campaign_not_found" };
    await repo.journeys.create(id, {
      campaignId,
      status: opts.status ?? "draft",
      graph,
      createdAt: now,
      updatedAt: now,
    });
  }

  const journey = await repo.journeys.getById(id);
  return { ok: true, journey: journey! };
}

export type SetJourneyStateResult =
  | {
      ok: true;
      status: JourneyStatus;
      enqueued?: number;
      /** People who were waiting while it was paused (engine move D1). */
      held?: ReleaseSummary;
      /** A launch on the lifecycle engine: people who waited there (engine move). */
      moved?: WaitlistReleaseSummary;
      result?: { processed: number; done: number; failed: number };
    }
  | { ok: false; error: "journey_not_found" | "journey_invalid" | "launch_archived"; reason?: string };

/**
 * Activate the journey (enqueue the first step for every verified subscriber,
 * then kick the worker for the due ones) or pause it. The ONLY place a journey
 * flips to "active" — deliberately NOT reachable from the agent path, so an
 * agent can never start real sends.
 */
export async function setJourneyState(
  ctx: TenantContext,
  campaignId: string,
  action: "activate" | "pause",
  db?: FirestoreLike,
): Promise<SetJourneyStateResult> {
  const repo = forTenant(ctx, db);
  const id = journeyIdFor(campaignId);

  // A launch moved to the lifecycle engine controls both engines (engine move).
  const campaignFirst = await repo.campaigns.getById(campaignId);
  if (campaignFirst?.waitlistEngine === "lifecycle") return setMovedLaunchState(ctx, campaignId, action, db);

  const journey = await repo.journeys.getById(id);
  if (!journey) return { ok: false, error: "journey_not_found" };
  const now = new Date().toISOString();

  if (action === "pause") {
    await repo.journeys.update(id, { status: "paused", updatedAt: now });
    return { ok: true, status: "paused" };
  }

  // An archived launch's steps can't send: publishing would enrol everyone and
  // then stop each first email. Restore the launch first (engine move D1).
  if (campaignFirst?.archivedAt) return { ok: false, error: "launch_archived" };

  // Refuse to activate an empty/half-wired journey: it would flip to "active",
  // enqueue nobody, and silently send nothing — the worst kind of failure.
  const valid = validateJourneyGraph(journey.graph);
  if (!valid.ok) {
    return { ok: false, error: "journey_invalid", reason: valid.reason };
  }

  await repo.journeys.update(id, { status: "active", updatedAt: now });
  const fresh = (await repo.journeys.getById(id))!;
  // People who waited while it was paused carry on first, then anyone new joins.
  const held = await releaseHeldJourneySteps(ctx, fresh, { db });
  const { enqueued } = await activateJourney(ctx, fresh, db);
  const result = await processEmailJobs(ctx, 25, db);
  return { ok: true, status: "active", enqueued, held, result };
}

/**
 * A launch moved to the lifecycle engine (engine move): "Turn welcome emails
 * back on" and pause control BOTH engines — its journey on the lifecycle engine,
 * and the original journey while people are still finishing on it. The
 * original journey only drains: resuming it releases whoever was waiting there
 * and never enrols anyone new.
 */
async function setMovedLaunchState(
  ctx: TenantContext,
  campaignId: string,
  action: "activate" | "pause",
  db?: FirestoreLike,
): Promise<SetJourneyStateResult> {
  const repo = forTenant(ctx, db);
  const campaign = await repo.campaigns.getById(campaignId);
  if (action === "activate" && campaign?.archivedAt) return { ok: false, error: "launch_archived" };
  const moved = await repo.lifecycleJourneys.getById(waitlistJourneyId(campaignId));
  const original = await repo.journeys.getById(journeyIdFor(campaignId));
  if (!moved && !original) return { ok: false, error: "journey_not_found" };
  const now = new Date().toISOString();

  if (action === "pause") {
    if (moved && moved.status === "active") await setLifecycleJourneyStatus(ctx, moved.id, "paused", { db });
    if (original?.status === "active") await repo.journeys.update(original.id, { status: "paused", updatedAt: now });
    return { ok: true, status: "paused" };
  }

  let movedRelease: WaitlistReleaseSummary | undefined;
  if (moved && moved.publishedVersion && moved.status !== "active") {
    const r = await setLifecycleJourneyStatus(ctx, moved.id, "active", { db });
    if (r.ok) movedRelease = r.value.released;
  }
  let held: ReleaseSummary | undefined;
  if (original?.status === "paused") {
    await repo.journeys.update(original.id, { status: "active", updatedAt: now });
    held = await releaseHeldJourneySteps(ctx, { ...original, status: "active" }, { db });
  }
  const result = await processEmailJobs(ctx, 25, db);
  return { ok: true, status: "active", enqueued: 0, ...(held ? { held } : {}), ...(movedRelease ? { moved: movedRelease } : {}), result };
}
