import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { WorkspaceTabs } from "@/components/admin/workspace/WorkspaceTabs";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { workspaceId } = await params;
  const workspace = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!workspace) notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <Link href="/admin/workspace" className="text-xs text-neutral-500 hover:underline">
            ← Workspaces
          </Link>
          <h1 className="text-xl font-semibold">{workspace.name}</h1>
        </div>
      </div>
      <WorkspaceTabs workspaceId={workspace.id} />
      <div className="pt-2">{children}</div>
    </div>
  );
}
