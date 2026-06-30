import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { NewWorkspaceForm } from "@/components/admin/workspace/NewWorkspaceForm";

export const dynamic = "force-dynamic";

export default async function WorkspaceListPage() {
  const ctx = await requireAdminContext();
  const all = await forTenant(ctx).workspaces.find({ where: [], limit: 200 });
  const workspaces = all
    .filter((w) => !w.archivedAt)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Workspaces</h1>
        <p className="text-sm text-neutral-500">
          Content production spaces. Each workspace has its own grounded knowledge base
          (Curate → Templatize → Create → Distribute).
        </p>
      </div>

      <NewWorkspaceForm />

      <div className="grid gap-3 sm:grid-cols-2">
        {workspaces.length === 0 ? (
          <div className="col-span-full rounded-md border border-dashed border-neutral-300 p-8 text-sm text-neutral-500 dark:border-neutral-700">
            No workspaces yet — create one above to start curating grounding sources.
          </div>
        ) : (
          workspaces.map((w) => (
            <Link
              key={w.id}
              href={`/admin/workspace/${w.id}/curate`}
              className="rounded-md border border-neutral-300 p-4 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              <div className="font-medium">{w.name}</div>
              {w.description ? (
                <p className="mt-1 line-clamp-2 text-sm text-neutral-500">{w.description}</p>
              ) : null}
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
