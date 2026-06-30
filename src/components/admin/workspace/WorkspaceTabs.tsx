"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Sub-tab strip for a workspace — the Content OS macro-pillars. Mirrors LaunchTabs. */
export function WorkspaceTabs({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/admin/workspace/${workspaceId}`;
  const tabs = [
    { href: `${base}/curate`, label: "Curate" },
    { href: `${base}/templatize`, label: "Templatize" },
    { href: `${base}/create`, label: "Create" },
    { href: `${base}/distribute`, label: "Distribute" },
    { href: `${base}/settings`, label: "Settings" },
  ];

  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {tabs.map((t) => {
        const active = pathname?.startsWith(t.href) ?? false;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-md border px-3 py-1 ${
              active
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
