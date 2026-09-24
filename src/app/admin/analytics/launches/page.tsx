import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { computeHybridAnalytics } from "@/lib/analytics/analytics";
import { isInsightsHubEnabled } from "@/lib/nav/flags";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { loadFunnel } from "@/lib/invites/funnel";
import { CampaignAnalyticsView } from "@/components/admin/CampaignAnalyticsView";
import { LaunchFunnel } from "@/components/admin/invites/LaunchFunnel";
import { Card } from "@/components/admin/insights/parts";

export const dynamic = "force-dynamic";

/** Insights › Launches (nav v2 phase 4): one launch's analytics, with its funnel into the product. */
export default async function InsightsLaunchesPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  if (!isInsightsHubEnabled()) notFound();
  const ctx = await requireAdminContext();
  const sp = await searchParams;
  const campaigns = await forTenant(ctx).campaigns.find({ orderBy: [["createdAt", "desc"]], limit: 50 });
  if (campaigns.length === 0) return <p className="text-sm text-neutral-500">No launches yet.</p>;
  const selected = campaigns.find((c) => c.id === sp.campaign) ?? campaigns[0]!;
  const invites = isInvitesUiEnabled() && isInvitesEnabled();
  const [analytics, funnel] = await Promise.all([
    computeHybridAnalytics(ctx, selected.id),
    invites ? loadFunnel(ctx, { campaignId: selected.id }).catch(() => null) : null,
  ]);
  return (
    <div className="space-y-6">
      {campaigns.length > 1 ? (
        <div className="flex flex-wrap gap-2 text-sm" aria-label="Launch">
          {campaigns.map((c) => (
            <Link
              key={c.id}
              href={`/admin/analytics/launches?campaign=${encodeURIComponent(c.id)}`}
              aria-current={c.id === selected.id ? "true" : undefined}
              className={`rounded-md border px-3 py-1 ${
                c.id === selected.id
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              {c.waitlistName}
            </Link>
          ))}
        </div>
      ) : null}
      {funnel ? (
        <Card title={`${selected.waitlistName}: from waitlist to product`}>
          <LaunchFunnel funnel={funnel} />
        </Card>
      ) : null}
      <CampaignAnalyticsView analytics={analytics} />
    </div>
  );
}
