import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { isNavV2Enabled } from "@/lib/nav/flags";
import { defaultPinIds } from "@/lib/nav/model";
import { PinButton } from "@/components/admin/nav/PinButton";

export const dynamic = "force-dynamic";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Every launch, active or archived (nav v2). The sidebar lists Launches once and
 * pins a few; this page is where the rest live, and where pins are chosen.
 */
export default async function LaunchesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  if (!isNavV2Enabled()) notFound();
  const ctx = await requireAdminContext();
  const sp = await searchParams;
  const view = sp.status === "archived" ? "archived" : "active";

  const campaigns = await forTenant(ctx).campaigns.find({
    orderBy: [["createdAt", "desc"]],
    limit: 100,
  });
  const active = campaigns.filter((c) => !c.archivedAt);
  const archived = campaigns.filter((c) => !!c.archivedAt);
  const rows = view === "archived" ? archived : active;
  const defaults = defaultPinIds(active.map((c) => ({ id: c.id, name: c.waitlistName })));

  const tabs = [
    { key: "active", label: `Active · ${active.length}`, href: "/admin/launches" },
    { key: "archived", label: `Archived · ${archived.length}`, href: "/admin/launches?status=archived" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Launches</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            A launch is a waitlist page and the emails that keep it warm. Star one to pin it to the sidebar.
          </p>
        </div>
        <Link
          href="/admin/launches/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          <Plus size={16} aria-hidden />
          New launch
        </Link>
      </div>

      <div className="flex gap-2 text-sm">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={view === t.key ? "page" : undefined}
            className={`rounded-md border px-3 py-1 ${
              view === t.key
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {view === "archived" ? (
            "No archived launches."
          ) : (
            <>
              <p>No launches yet. Your first one takes a couple of minutes.</p>
              <Link href="/admin/launches/new" className="mt-3 inline-block font-medium text-neutral-900 underline underline-offset-4 dark:text-neutral-100">
                Create a launch
              </Link>
            </>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-md border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-2 pr-2 hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
              <Link href={`/admin/launches/${c.id}`} className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 py-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{c.waitlistName}</span>
                  <span className="ml-2 text-neutral-500 dark:text-neutral-400">/{c.id}</span>
                  {c.archivedAt ? (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      Archived
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                  Started {formatDate(c.createdAt)}
                </span>
              </Link>
              <PinButton tenantId={ctx.tenantId} launchId={c.id} launchName={c.waitlistName} defaultIds={defaults} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
