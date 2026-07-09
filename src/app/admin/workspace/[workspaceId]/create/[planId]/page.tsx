import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { getContentPlan, listTemplates } from "@/lib/tenant/workspaceContent";
import { isEbookUiEnabled } from "@/lib/content/create/ebook";
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
  const [plan, templates] = await Promise.all([
    getContentPlan(ctx, workspaceId, planId),
    listTemplates(ctx, workspaceId),
  ]);
  if (!plan) notFound();

  // An eBook that hasn't been finalized (no graph yet) has no canvas to show — send the
  // operator back into the authoring studio to resume (also covers a stale/bookmarked URL).
  if (isEbookUiEnabled() && plan.topology.hubChannel === "ebook" && plan.graph.nodes.length === 0) {
    redirect(`/admin/workspace/${workspaceId}/create/${planId}/ebook`);
  }

  const templateOptions = templates.map((t) => ({
    id: t.id,
    title: t.title,
    channel: t.channel ?? null,
    blockType: t.blockType ?? null,
    tier: t.tier ?? null,
    framework: t.framework ?? null,
  }));

  return (
    <div className="space-y-3">
      <Link
        href={`/admin/workspace/${workspaceId}/create`}
        className="text-xs text-neutral-500 hover:underline"
      >
        ← All workflows
      </Link>
      <ContentCanvas
        workspaceId={workspaceId}
        initial={plan}
        templates={templateOptions}
        brandName={ws.name}
      />
    </div>
  );
}
