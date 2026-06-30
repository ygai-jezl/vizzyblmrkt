import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { WorkspaceSettings } from "@/components/admin/workspace/WorkspaceSettings";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();

  return (
    <WorkspaceSettings
      workspaceId={workspaceId}
      initial={{ topics: ws.topics ?? [], defaultTags: ws.defaultTags ?? [] }}
    />
  );
}
