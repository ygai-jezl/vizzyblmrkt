import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { waitlistJourneyRows, type WaitlistJourneyRow } from "./waitlistJourneyRows";
import { loadMovedJourneys } from "./launchJourneyLoad";

export { WAITLIST_STATUS_LABEL, waitlistJourneyRows } from "./waitlistJourneyRows";
export type { WaitlistJourneyRow, WaitlistJourneyStatus } from "./waitlistJourneyRows";

/** Every launch's waitlist journey, for the Journeys list (server only). */
export async function loadWaitlistJourneys(ctx: TenantContext, db?: FirestoreLike): Promise<WaitlistJourneyRow[]> {
  const repos = forTenant(ctx, db);
  const [campaigns, journeys, moved] = await Promise.all([
    repos.campaigns.find({ orderBy: [["createdAt", "desc"]], limit: 100 }),
    repos.journeys.find({ limit: 200 }),
    loadMovedJourneys(ctx, db),
  ]);
  return waitlistJourneyRows(campaigns, journeys, moved);
}
