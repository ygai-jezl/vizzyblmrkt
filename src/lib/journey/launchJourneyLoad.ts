import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Journey } from "@/lib/types/journey";
import type { LifecycleJourney } from "@/lib/types/lifecycle";
import { waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { welcomeJourney, type WelcomeJourney } from "./launchJourney";

/** Load a launch's welcome journey, on whichever engine it's on (server only). */
export async function loadWelcomeJourney(
  ctx: TenantContext,
  campaign: Pick<Campaign, "id" | "waitlistEngine">,
  db?: FirestoreLike,
): Promise<{ view: WelcomeJourney; legacy: Journey | null; lifecycle: LifecycleJourney | null }> {
  const repo = forTenant(ctx, db);
  const [legacy, lifecycle] = await Promise.all([
    repo.journeys.getById(`journey_${campaign.id}`).catch(() => null),
    campaign.waitlistEngine && campaign.waitlistEngine !== "legacy"
      ? repo.lifecycleJourneys.getById(waitlistJourneyId(campaign.id)).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { view: welcomeJourney(campaign, legacy, lifecycle), legacy, lifecycle };
}

/** Every launch's journey on the lifecycle engine, keyed by launch id (equality-only query). */
export async function loadMovedJourneys(ctx: TenantContext, db?: FirestoreLike): Promise<Map<string, LifecycleJourney>> {
  const rows = await forTenant(ctx, db)
    .lifecycleJourneys.find({ where: [["connectionId", "==", ""]], limit: 500 })
    .catch(() => []);
  return new Map(rows.flatMap((j) => (j.audience?.kind === "waitlist" ? [[j.audience.campaignId, j] as const] : [])));
}
