"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Tab strip for the global Account Settings area. Mirrors {@link LaunchTabs}'
 * "border pill" style. Domains lives at the base route (exact match); Billing is
 * a child route matched by prefix.
 */
export function AccountTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/admin/account", label: "Domains", exact: true },
    { href: "/admin/account/settings", label: "Settings", exact: false },
    { href: "/admin/account/connections", label: "Connections", exact: false },
    { href: "/admin/account/billing", label: "Billing", exact: false },
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
