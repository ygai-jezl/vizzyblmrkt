import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { toCampaignSettings } from "@/lib/admin/campaignSettings";
import { getSenderConfig } from "@/lib/admin/senderConfig";
import { CampaignSettingsForm } from "@/components/admin/CampaignSettingsForm";
import { isNavV2Enabled } from "@/lib/nav/flags";

export const dynamic = "force-dynamic";

export default async function CampaignSettingsPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  // Nav v2: the launch's own Settings tab (with Archive / Delete).
  if (isNavV2Enabled()) redirect(`/admin/launches/${encodeURIComponent(campaignId)}/settings`);
  const ctx = await requireAdminContext();

  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) notFound();
  const senderConfig = await getSenderConfig(ctx.tenantId);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <Link href="/admin/settings" className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
          ← All campaigns
        </Link>
        <h1 className="text-xl font-semibold">{campaign.waitlistName}</h1>
        <p className="text-sm text-neutral-500">
          /{campaign.id} ·{" "}
          {campaign.waitlistUrlLocation ? (
            <>
              live at{" "}
              <code className="text-neutral-600 dark:text-neutral-400">
                {campaign.waitlistUrlLocation}
              </code>
            </>
          ) : (
            <>
              hosted at <code className="text-neutral-600 dark:text-neutral-400">/waitlist/{campaign.id}</code>
            </>
          )}
        </p>
      </div>

      <CampaignSettingsForm
        campaignId={campaign.id}
        initial={toCampaignSettings(campaign)}
        senderConfig={senderConfig}
      />
    </div>
  );
}
