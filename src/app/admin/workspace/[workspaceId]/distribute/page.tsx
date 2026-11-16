import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { listScheduledPosts } from "@/lib/distribute/scheduler";
import { toCalendarNewsletters } from "@/lib/distribute/uiModel";
import { DistributeClient } from "@/components/admin/distribute/DistributeClient";
import { isPostResultsEnabled } from "@/lib/distribute/flags";
import { postLearningFor } from "@/lib/distribute/learnFromPostEdit";
import { isAiDraftKeptEnabled } from "@/lib/content/create/flags";
import { loadPostExtras } from "@/lib/distribute/postExtras";

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
  // Results and Vizzy's draft on each card (each behind its switch; empty when both are off).
  const extrasOpts = { results: isPostResultsEnabled(), drafts: isAiDraftKeptEnabled() };
  const [extras, learning] = await Promise.all([
    extrasOpts.results || extrasOpts.drafts ? loadPostExtras(ctx, posts, extrasOpts).catch(() => ({})) : {},
    postLearningFor(ctx),
  ]);

  return (
    <DistributeClient
      workspaceId={workspaceId}
      initialPlans={plans}
      initialPosts={posts}
      initialNewsletters={newsletters}
      extras={extras}
      learning={learning}
    />
  );
}
