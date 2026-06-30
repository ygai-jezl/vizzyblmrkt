import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { CreatePanel } from "@/components/admin/workspace/create/CreatePanel";

export const dynamic = "force-dynamic";

/** Create pillar: list saved content workflows + the intake wizard for new ones. */
export default async function CreatePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();

  const [plans, sources] = await Promise.all([
    listContentPlans(ctx, workspaceId),
    forTenant(ctx).ingestionTickets.find({
      where: [
        ["ownerKind", "==", "workspace"],
        ["ownerId", "==", workspaceId],
      ],
      limit: 200,
    }),
  ]);
  sources.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  return (
    <CreatePanel
      workspaceId={workspaceId}
      initialPlans={plans}
      topics={ws.topics ?? []}
      initialSources={sources}
    />
  );
}
