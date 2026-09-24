"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

/**
 * Sub-tab strip for a launch workspace. Reuses the "border pill" style from the
 * analytics campaign switcher. Overview matches exactly (it's the prefix of the
 * others); each tool tab matches its own path prefix.
 */
export function LaunchTabs({ campaignId }: { campaignId: string }) {
  const pathname = usePathname();
  const base = `/admin/launches/${campaignId}`;
  // Nav v2 phase 3: the page and widget together, and one Emails tab that also
  // lights up on the journey and broadcasts it links to.
  const tabs: Array<{ href: string; label: string; exact: boolean; also?: string[] }> = isNavV2Phase3Enabled()
    ? [
        { href: base, label: "Overview", exact: true },
        { href: `${base}/widget`, label: "Page & widget", exact: false },
        { href: `${base}/signups`, label: "Signups", exact: false },
        { href: `${base}/emails`, label: "Emails", exact: false, also: [`${base}/journey`, `${base}/broadcasts`, `${base}/invites`] },
        { href: `${base}/analytics`, label: "Analytics", exact: false },
        { href: `${base}/settings`, label: "Settings", exact: false },
      ]
    : [
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
          : [t.href, ...(t.also ?? [])].some((h) => pathname?.startsWith(h) ?? false);
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
    </div>
  );
}
