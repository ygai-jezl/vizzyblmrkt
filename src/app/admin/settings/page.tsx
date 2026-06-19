import Link from "next/link";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = await requireAdminContext();

  const campaigns = await forTenant(ctx).campaigns.find({
    orderBy: [["createdAt", "desc"]],
    limit: 100,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Campaign settings</h1>
        <span className="text-sm text-neutral-500">{campaigns.length} campaign{campaigns.length === 1 ? "" : "s"}</span>
      </div>

      {campaigns.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No campaigns yet.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Link
                href={`/admin/settings/${c.id}`}
                className="flex items-center justify-between px-4 py-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
              >
                <span>
                  <span className="font-medium">{c.waitlistName}</span>
                  <span className="ml-2 text-neutral-400">/{c.id}</span>
                  {c.archivedAt ? (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      Archived
                    </span>
                  ) : null}
                </span>
                <span className="text-neutral-400">Edit →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
