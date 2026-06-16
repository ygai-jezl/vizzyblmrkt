import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { BroadcastsView } from "@/components/admin/email/BroadcastsView";

export const dynamic = "force-dynamic";

export default async function LaunchBroadcastsPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const broadcasts = await forTenant(ctx).broadcasts.find({
    where: [["campaignId", "==", campaignId]],
    orderBy: [["createdAt", "desc"]],
  });

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">Broadcasts</h2>
      <BroadcastsView campaignId={campaignId} initial={broadcasts} />
    </div>
  );
}
