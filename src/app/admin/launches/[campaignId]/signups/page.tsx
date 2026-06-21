import { requireAdminContext } from "@/lib/auth/session";
import { fetchAdminSignupRows } from "@/lib/admin/signups";
import { SignupsTable } from "@/components/admin/SignupsTable";
import { SignupsTabs } from "@/components/admin/SignupsTabs";

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
        <span className="text-sm text-neutral-500">{rows.length} shown</span>
      </div>
      <SignupsTabs base={`/admin/launches/${campaignId}/signups`} active={mode} />
      <SignupsTable initialRows={rows} mode={mode} campaignId={campaignId} />
    </div>
  );
}
