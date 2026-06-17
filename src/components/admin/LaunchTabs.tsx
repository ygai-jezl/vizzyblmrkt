"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Sub-tab strip for a launch workspace. Reuses the "border pill" style from the
 * analytics campaign switcher. Overview matches exactly (it's the prefix of the
 * others); each tool tab matches its own path prefix.
 */
export function LaunchTabs({ campaignId }: { campaignId: string }) {
  const pathname = usePathname();
  const base = `/admin/launches/${campaignId}`;
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/signups`, label: "Signups", exact: false },
    { href: `${base}/analytics`, label: "Analytics", exact: false },
    { href: `${base}/broadcasts`, label: "Broadcasts", exact: false },
    { href: `${base}/journey`, label: "Journey", exact: false },
    { href: `${base}/widget`, label: "Embed & Design", exact: false },
    { href: `${base}/settings`, label: "Settings", exact: false },
  ];

  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {tabs.map((t) => {
        const active = t.exact
          ? pathname === t.href
          : (pathname?.startsWith(t.href) ?? false);
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
