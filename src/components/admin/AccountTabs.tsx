"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isPlansUiEnabled } from "@/lib/plans/flags";

/**
 * Tab strip for the global Account Settings area. Mirrors {@link LaunchTabs}'
 * "border pill" style. Domains lives at the base route (exact match); Billing
 * (Plan and usage with NEXT_PUBLIC_PLANS_ENABLED) is a child route matched by prefix.
 */
export function AccountTabs({ dataModel = false }: {
  /** Settings › Data model (AUDIENCE_FIELDS_ENABLED, a server switch): worked out by the layout. */
  dataModel?: boolean;
} = {}) {
  const pathname = usePathname();
  // Nav v2 phase 3: General first; the guidelines moved to Brand; Billing stays
  // hidden until there is something to bill (no "Coming soon" tabs). With
  // NEXT_PUBLIC_PLANS_ENABLED its page is Plan and usage, which always has
  // something to show, so it joins the list.
  const plans = isPlansUiEnabled();
  const tabs = isNavV2Phase3Enabled()
    ? [
        { href: "/admin/account/settings", label: "General", exact: false },
        { href: "/admin/account", label: "Sending", exact: true },
        { href: "/admin/account/connections", label: "Connections", exact: false },
        ...(plans ? [{ href: "/admin/account/billing", label: "Plan and usage", exact: false }] : []),
        ...(dataModel ? [{ href: "/admin/account/data-model", label: "Data model", exact: false }] : []),
      ]
    : [
        { href: "/admin/account", label: "Domains", exact: true },
        { href: "/admin/account/brand", label: "Brand", exact: false },
        { href: "/admin/account/settings", label: "Settings", exact: false },
        { href: "/admin/account/connections", label: "Connections", exact: false },
        { href: "/admin/account/billing", label: plans ? "Plan and usage" : "Billing", exact: false },
        ...(dataModel ? [{ href: "/admin/account/data-model", label: "Data model", exact: false }] : []),
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
