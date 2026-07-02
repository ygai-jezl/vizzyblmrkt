import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { listScheduledPosts } from "@/lib/distribute/scheduler";
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

  const [plans, posts] = await Promise.all([
    listContentPlans(ctx, workspaceId),
    listScheduledPosts(ctx, workspaceId),
  ]);

  return (
    <DistributeClient workspaceId={workspaceId} initialPlans={plans} initialPosts={posts} />
  );
}
