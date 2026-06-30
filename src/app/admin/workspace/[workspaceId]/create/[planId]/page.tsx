import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { ContentCanvas } from "@/components/admin/workspace/create/ContentCanvas";

export const dynamic = "force-dynamic";

/** Canvas for one content workflow — the Architect's graph, filled progressively. */
export default async function ContentPlanPage({
  params,
}: {
  params: Promise<{ workspaceId: string; planId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId, planId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) notFound();

  return (
    <div className="space-y-3">
      <Link
        href={`/admin/workspace/${workspaceId}/create`}
        className="text-xs text-neutral-500 hover:underline"
      >
        ← All workflows
      </Link>
      <ContentCanvas workspaceId={workspaceId} initial={plan} />
    </div>
  );
}
