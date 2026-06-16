import { requireAdminContext } from "@/lib/auth/session";
import { computeCampaignAnalytics } from "@/lib/analytics/analytics";
import { CampaignAnalyticsView } from "@/components/admin/CampaignAnalyticsView";

export const dynamic = "force-dynamic";

export default async function LaunchAnalyticsPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const analytics = await computeCampaignAnalytics(ctx, campaignId);

  return <CampaignAnalyticsView analytics={analytics} />;
}
