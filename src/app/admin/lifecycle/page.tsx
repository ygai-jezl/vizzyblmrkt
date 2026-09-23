import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { loadWaitlistJourneys } from "@/lib/journey/waitlistJourneys";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { JourneysHome } from "@/components/admin/lifecycle/JourneysHome";

export const dynamic = "force-dynamic";

/**
 * Journeys. Lifecycle journeys for connected products (LIFECYCLE_ENABLED); with
 * nav v2 phase 3, every launch's waitlist journey too — the one list of automated
 * email, which exists even where lifecycle is off.
 */
export default async function LifecyclePage() {
  const ctx = await requireAdminContext();
  const lifecycle = isLifecycleEnabled();
  if (isNavV2Phase3Enabled()) {
    const waitlist = await loadWaitlistJourneys(ctx).catch(() => []);
    return <JourneysHome canEdit={ctx.role === "admin"} lifecycle={lifecycle} waitlist={waitlist} />;
  }
  if (!lifecycle) notFound();
  return <JourneysHome canEdit={ctx.role === "admin"} />;
}
