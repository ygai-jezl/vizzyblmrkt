import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { listScheduledPosts } from "@/lib/distribute/scheduler";
import { toCalendarNewsletters } from "@/lib/distribute/uiModel";
import { DistributeClient } from "@/components/admin/distribute/DistributeClient";

export const dynamic = "force-dynamic";

/** Distribute pillar: schedule approved Create nodes onto the queue + calendar. */
export default async function DistributePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();

  const [plans, posts, broadcasts] = await Promise.all([
    listContentPlans(ctx, workspaceId),
    listScheduledPosts(ctx, workspaceId),
    // Weekly newsletters composed from THIS workspace's hubs (they alone carry
    // sourceWorkspaceId). Single-field equality → auto-indexed; sorted in memory.
    forTenant(ctx).broadcasts.find({ where: [["sourceWorkspaceId", "==", workspaceId]] }),
  ]);
  const newsletters = toCalendarNewsletters(broadcasts);

  return (
    <DistributeClient
      workspaceId={workspaceId}
      initialPlans={plans}
      initialPosts={posts}
      initialNewsletters={newsletters}
    />
  );
}
