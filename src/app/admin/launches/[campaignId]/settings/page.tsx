import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { toCampaignSettings } from "@/lib/admin/campaignSettings";
import { getSenderConfig } from "@/lib/admin/senderConfig";
import { CampaignSettingsForm } from "@/components/admin/CampaignSettingsForm";
import { DeleteLaunchSection } from "@/components/admin/DeleteLaunchSection";

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
  const senderConfig = await getSenderConfig(ctx.tenantId);

  return (
    <div className="max-w-3xl space-y-4">
      <h2 className="text-sm font-semibold">Settings</h2>
      <CampaignSettingsForm
        campaignId={campaign.id}
        initial={toCampaignSettings(campaign)}
        senderConfig={senderConfig}
      />
      {ctx.role === "admin" ? (
        <DeleteLaunchSection
          campaignId={campaign.id}
          campaignName={campaign.waitlistName}
        />
      ) : null}
    </div>
  );
}
