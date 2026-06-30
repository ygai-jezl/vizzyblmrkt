import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { listIdeaItems } from "@/lib/tenant/workspaceContent";
import { IdeaBoardPanel } from "@/components/admin/workspace/IdeaBoardPanel";

export const dynamic = "force-dynamic";

/** Idea Board sub-tab: zero-friction capture (links / screenshots / text) → templatize. */
export default async function IdeaBoardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();

  const items = await listIdeaItems(ctx, workspaceId);
  return <IdeaBoardPanel workspaceId={workspaceId} initialItems={items} />;
}
