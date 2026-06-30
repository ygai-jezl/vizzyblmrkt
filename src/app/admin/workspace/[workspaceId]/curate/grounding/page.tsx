import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { CuratePanel } from "@/components/admin/workspace/CuratePanel";

export const dynamic = "force-dynamic";

/** Grounding sub-tab: ingest URLs/repos → vector RAG (the original Curate view). */
export default async function GroundingPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) notFound();

  const sources = await forTenant(ctx).ingestionTickets.find({
    where: [
      ["ownerKind", "==", "workspace"],
      ["ownerId", "==", workspaceId],
    ],
    limit: 200,
  });
  sources.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  return <CuratePanel workspaceId={workspaceId} initialSources={sources} />;
}
