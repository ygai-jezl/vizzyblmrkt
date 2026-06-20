import type { TenantContext } from "@/lib/tenant";
import { forTenant } from "@/lib/tenant";
import type { Journey, JourneyGraph, JourneyStatus } from "@/lib/types/journey";
import {
  activateJourney,
  processEmailJobs,
  validateJourneyGraph,
} from "@/lib/email/delivery";

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
      result?: { processed: number; done: number; failed: number };
    }
  | { ok: false; error: "journey_not_found" | "journey_invalid"; reason?: string };

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
): Promise<SetJourneyStateResult> {
  const repo = forTenant(ctx);
  const id = journeyIdFor(campaignId);

  const journey = await repo.journeys.getById(id);
  if (!journey) return { ok: false, error: "journey_not_found" };
  const now = new Date().toISOString();

  if (action === "pause") {
    await repo.journeys.update(id, { status: "paused", updatedAt: now });
    return { ok: true, status: "paused" };
  }

  // Refuse to activate an empty/half-wired journey: it would flip to "active",
  // enqueue nobody, and silently send nothing — the worst kind of failure.
  const valid = validateJourneyGraph(journey.graph);
  if (!valid.ok) {
    return { ok: false, error: "journey_invalid", reason: valid.reason };
  }

  await repo.journeys.update(id, { status: "active", updatedAt: now });
  const fresh = await repo.journeys.getById(id);
  const { enqueued } = await activateJourney(ctx, fresh!);
  const result = await processEmailJobs(ctx);
  return { ok: true, status: "active", enqueued, result };
}
