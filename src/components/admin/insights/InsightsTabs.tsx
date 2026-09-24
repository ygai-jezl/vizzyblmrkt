"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Insights' tab strip (nav v2 phase 4). Mirrors LaunchTabs' pill style. */
export function InsightsTabs({ market }: { market: boolean }) {
  const pathname = usePathname() ?? "";
  const base = "/admin/analytics";
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/launches`, label: "Launches" },
    { href: `${base}/email`, label: "Email" },
    { href: `${base}/content`, label: "Content" },
    { href: `${base}/journeys`, label: "Journeys" },
    ...(market ? [{ href: `${base}/market`, label: "Market" }] : []),
  ];
  return (
    <nav aria-label="Insights" className="flex flex-wrap gap-2 text-sm">
      {tabs.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
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
    </nav>
  );
}
