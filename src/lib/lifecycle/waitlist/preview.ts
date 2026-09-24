import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { convertLegacyJourney, type ConversionReport } from "./convert";
import { waitlistJourneyId } from "./ids";

/**
 * The engine-move DRY RUN for one launch (engine move D3): what converting its
 * welcome journey would produce, and who it would affect — counts only, never a
 * person. Read-only; admins only (see the route).
 */

export interface EngineMovePreview {
  launch: { id: string; name: string; archived: boolean };
  original: {
    exists: boolean;
    status: "draft" | "active" | "paused" | null;
    emails: number;
    /** People with a step queued, held or running on the original engine: they'd finish there. */
    peopleInJourney: number;
  };
  verifiedSignups: number;
  /** The launch's journey on the lifecycle engine, if it has one already. */
  lifecycle: { journeyId: string; exists: boolean; status: string | null };
  conversion: ConversionReport | null;
  converted: { nodes: number; emails: number; abTests: number } | null;
}

export async function previewEngineMove(
  ctx: TenantContext,
  campaignId: string,
  db?: FirestoreLike,
): Promise<EngineMovePreview | null> {
  const repo = forTenant(ctx, db);
  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) return null;
  const lifecycleId = waitlistJourneyId(campaignId);
  const [journey, moved, verifiedSignups, ...inFlight] = await Promise.all([
    repo.journeys.getById(`journey_${campaignId}`),
    repo.lifecycleJourneys.getById(lifecycleId),
    repo.signups.count([
      ["campaignId", "==", campaignId],
      ["status", "==", "verified_active"],
    ]),
    ...(["pending", "held", "processing"] as const).map((status) =>
      repo.emailJobs.count([
        ["campaignId", "==", campaignId],
        ["type", "==", "journey_step"],
        ["status", "==", status],
      ]),
    ),
  ]);
  const converted = journey ? convertLegacyJourney(journey) : null;
  return {
    launch: { id: campaign.id, name: campaign.waitlistName, archived: Boolean(campaign.archivedAt) },
    original: {
      exists: Boolean(journey),
      status: journey?.status ?? null,
      emails: journey ? journey.graph.nodes.filter((n) => n.type === "email").length : 0,
      peopleInJourney: inFlight.reduce((a, b) => a + b, 0),
    },
    verifiedSignups,
    lifecycle: { journeyId: lifecycleId, exists: Boolean(moved), status: moved?.status ?? null },
    conversion: converted?.report ?? null,
    converted: converted?.draft
      ? {
          nodes: converted.draft.graph.nodes.length,
          emails: converted.draft.graph.nodes.filter((n) => n.type === "email").length,
          abTests: converted.draft.pools.filter((p) => p.abTest).length,
        }
      : null,
  };
}
