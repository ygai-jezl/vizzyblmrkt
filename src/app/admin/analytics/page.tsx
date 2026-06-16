import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { computeCampaignAnalytics } from "@/lib/analytics/analytics";
import { CampaignAnalyticsView } from "@/components/admin/CampaignAnalyticsView";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const ctx = await requireAdminContext();
  const sp = await searchParams;

  const campaigns = await forTenant(ctx).campaigns.find({
    orderBy: [["createdAt", "desc"]],
    limit: 50,
  });

  if (campaigns.length === 0) {
    return <p className="text-sm text-neutral-500">No campaigns yet.</p>;
  }

  const selected = campaigns.find((c) => c.id === sp.campaign) ?? campaigns[0]!;
  const analytics = await computeCampaignAnalytics(ctx, selected.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Analytics</h1>
        {campaigns.length > 1 ? (
          <div className="flex gap-2 text-sm">
            {campaigns.map((c) => (
              <Link
                key={c.id}
                href={`/admin/analytics?campaign=${c.id}`}
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
      </div>

      <CampaignAnalyticsView analytics={analytics} />
    </div>
  );
}
