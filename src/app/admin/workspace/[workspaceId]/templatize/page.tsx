import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listTemplates } from "@/lib/tenant/workspaceContent";
import { TemplatizePanel } from "@/components/admin/workspace/TemplatizePanel";

export const dynamic = "force-dynamic";

export default async function TemplatizePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();

  const templates = await listTemplates(ctx, workspaceId);
  return (
    <TemplatizePanel
      workspaceId={workspaceId}
      initialTemplates={templates}
      initialGroups={ws.templateGroups ?? []}
    />
  );
}
