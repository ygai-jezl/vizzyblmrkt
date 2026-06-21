import { requireAdminContext } from "@/lib/auth/session";
import { computeCampaignAnalytics } from "@/lib/analytics/analytics";
import { CampaignAnalyticsView } from "@/components/admin/CampaignAnalyticsView";
import { EmailAnalyticsSection } from "@/components/admin/email/EmailAnalyticsSection";

export const dynamic = "force-dynamic";

export default async function LaunchAnalyticsPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const analytics = await computeCampaignAnalytics(ctx, campaignId);

  // Email engagement lives only in the per-launch tab (NOT in the shared
  // CampaignAnalyticsView, which the global analytics page also renders).
  return (
    <div className="space-y-8">
      <CampaignAnalyticsView analytics={analytics} />
      <EmailAnalyticsSection campaignId={campaignId} />
    </div>
  );
}
