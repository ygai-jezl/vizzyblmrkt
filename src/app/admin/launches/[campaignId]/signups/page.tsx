import { requireAdminContext } from "@/lib/auth/session";
import { fetchAdminSignupRows } from "@/lib/admin/signups";
import { SignupsTable } from "@/components/admin/SignupsTable";
import { SignupsTabs } from "@/components/admin/SignupsTabs";
import Link from "next/link";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

export const dynamic = "force-dynamic";

export default async function LaunchSignupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const sp = await searchParams;
  const mode = sp.status === "offboarded" ? "offboarded" : "active";
  const rows = await fetchAdminSignupRows(ctx, { campaignId, status: mode });

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Signups</h2>
        <span className="flex items-baseline gap-3 text-sm text-neutral-500">
          {rows.length} shown
          {/* Nav v2 phase 3: Audience is the one home for people; this is the launch's own view. */}
          {isNavV2Phase3Enabled() ? (
            <Link href={`/admin/crm?launch=${encodeURIComponent(campaignId)}`} className="font-medium text-blue-700 hover:underline dark:text-blue-300">
              See them in Audience →
            </Link>
          ) : null}
        </span>
      </div>
      <SignupsTabs base={`/admin/launches/${campaignId}/signups`} active={mode} />
      <SignupsTable initialRows={rows} mode={mode} campaignId={campaignId} />
    </div>
  );
}
