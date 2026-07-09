import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { listReadyHubs } from "@/lib/distribute/weeklyHubs";
import { WeeklyClient } from "@/components/admin/workspace/weekly/WeeklyClient";

export const dynamic = "force-dynamic";

/**
 * Weekly newsletter: a library of ready hub newsletters across the workspace's
 * plans. The operator picks one each week, confirms the subject, and sends it to
 * a launch's weekly-newsletter audience (the opt-in subset from the Exit node).
 */
export default async function WeeklyPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();

  const [plans, allCampaigns] = await Promise.all([
    listContentPlans(ctx, workspaceId),
    forTenant(ctx).campaigns.find({ orderBy: [["createdAt", "desc"]] }),
  ]);

  const hubs = listReadyHubs(plans);
  const campaigns = allCampaigns
    .filter((c) => !c.archivedAt)
    .map((c) => ({ id: c.id, name: c.waitlistName || c.id }));

  return (
    <WeeklyClient workspaceId={workspaceId} hubs={hubs} campaigns={campaigns} />
  );
}
