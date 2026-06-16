import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { computeCampaignAnalytics } from "@/lib/analytics/analytics";

export const dynamic = "force-dynamic";

/**
 * Compact launch overview: a few headline KPIs (the full breakdown lives in the
 * Analytics tab) plus quick links into the launch's tools. The campaign is
 * guaranteed to exist by the parent layout.
 */
export default async function LaunchOverviewPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const a = await computeCampaignAnalytics(ctx, campaignId);
  const base = `/admin/launches/${campaignId}`;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Total signups" value={a.totalSignups} hint="verified + unverified" />
        <Tile label="Verified" value={a.verifiedSignups} />
        <Tile label="Total referrals" value={a.totalReferrals} />
        <Tile label="Last signup" value={relative(a.lastSignupAt)} small />
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Quick href={`${base}/signups`}>View signups</Quick>
        <Quick href={`${base}/analytics`}>Full analytics</Quick>
        <Quick href={`${base}/widget`}>Get embed widget</Quick>
        <Quick href={`${base}/settings`}>Edit settings</Quick>
        <Quick href={`/waitlist/${campaignId}`}>Open hosted page ↗</Quick>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  small,
}: {
  label: string;
  value: number | string;
  hint?: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={small ? "mt-1 text-base font-medium" : "mt-1 text-2xl font-semibold tabular-nums"}>
        {value}
      </div>
      {hint ? <div className="text-xs text-neutral-400">{hint}</div> : null}
    </div>
  );
}

function Quick({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      {children}
    </Link>
  );
}

function relative(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
