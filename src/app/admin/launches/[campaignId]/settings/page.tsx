import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { toCampaignSettings } from "@/lib/admin/campaignSettings";
import { getSenderConfig } from "@/lib/admin/senderConfig";
import { CampaignSettingsForm } from "@/components/admin/CampaignSettingsForm";
import { ArchiveLaunchSection } from "@/components/admin/ArchiveLaunchSection";
import { DeleteLaunchSection } from "@/components/admin/DeleteLaunchSection";
import { loadWelcomeJourney } from "@/lib/journey/launchJourneyLoad";
import { countHeldWaitlistEnrolments } from "@/lib/lifecycle/waitlist/enrol";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isHoldOnPauseEnabled } from "@/lib/journey/flags";
import { countHeldJourneySteps } from "@/lib/journey/hold";

export const dynamic = "force-dynamic";

export default async function LaunchSettingsPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) notFound();
  const [senderConfig, welcome] = await Promise.all([
    getSenderConfig(ctx.tenantId),
    isNavV2Phase3Enabled() ? loadWelcomeJourney(ctx, campaign).catch(() => null) : null,
  ]);
  const journeyPaused = welcome?.view.status === "paused";
  // Engine move: how many people are waiting part-way through the paused journey —
  // on the lifecycle engine (which always holds), plus any still finishing on the original.
  const moved = welcome?.view.engine === "lifecycle";
  const holdOnPause = moved || isHoldOnPauseEnabled();
  const waiting = !journeyPaused || !holdOnPause
    ? null
    : await Promise.all([
        moved && welcome?.view.journeyId ? countHeldWaitlistEnrolments(ctx, welcome.view.journeyId) : 0,
        isHoldOnPauseEnabled() ? countHeldJourneySteps(ctx, campaignId) : 0,
      ])
        .then(([a, b]) => a + b)
        .catch(() => null);

  return (
    <div className="max-w-3xl space-y-4">
      <h2 className="text-sm font-semibold">Settings</h2>
      {campaign.archivedAt ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          This launch is <span className="font-medium">archived</span> — its
          public waitlist is closed to new signups. Restore it below to reopen.
        </div>
      ) : null}
      <CampaignSettingsForm
        campaignId={campaign.id}
        initial={toCampaignSettings(campaign)}
        senderConfig={senderConfig}
      />
      {ctx.role === "admin" ? (
        <>
          <ArchiveLaunchSection
            campaignId={campaign.id}
            campaignName={campaign.waitlistName}
            archived={!!campaign.archivedAt}
            journeyPaused={journeyPaused}
            waiting={waiting}
            holdOnPause={holdOnPause}
          />
          <DeleteLaunchSection
            campaignId={campaign.id}
            campaignName={campaign.waitlistName}
          />
        </>
      ) : null}
    </div>
  );
}
