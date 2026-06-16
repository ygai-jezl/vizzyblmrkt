import { requireAdminContext } from "@/lib/auth/session";
import { fetchAdminSignupRows } from "@/lib/admin/signups";
import { SignupsTable } from "@/components/admin/SignupsTable";

export const dynamic = "force-dynamic";

export default async function LaunchSignupsPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const rows = await fetchAdminSignupRows(ctx, { campaignId });

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Signups</h2>
        <span className="text-sm text-neutral-500">{rows.length} shown</span>
      </div>
      <SignupsTable initialRows={rows} />
    </div>
  );
}
