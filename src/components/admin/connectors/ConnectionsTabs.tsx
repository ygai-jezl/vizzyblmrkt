"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Settings › Connections. Accounts stays on this base route: every sign in callback returns here. */
export const CONNECTIONS_BASE = "/admin/account/connections";

export type ConnectionsTabKey = "accounts" | "browse" | "connected";

const TABS: ReadonlyArray<{ key: ConnectionsTabKey; label: string; href: string }> = [
  { key: "accounts", label: "Accounts", href: CONNECTIONS_BASE },
  { key: "browse", label: "Browse", href: `${CONNECTIONS_BASE}/browse` },
  { key: "connected", label: "Connected", href: `${CONNECTIONS_BASE}/connected` },
];

/**
 * Which sub-tab a path is on: the base route is Accounts (GitHub, GitLab, LinkedIn and X),
 * /connected is Connected, and Browse holds the rest, because a connector's Listing and its picker
 * are reached from Browse.
 */
export function connectionsTabOf(pathname: string | null | undefined): ConnectionsTabKey {
  const p = (pathname ?? CONNECTIONS_BASE).replace(/\/+$/, "");
  if (p === CONNECTIONS_BASE) return "accounts";
  if (p === `${CONNECTIONS_BASE}/connected` || p.startsWith(`${CONNECTIONS_BASE}/connected/`)) return "connected";
  return "browse";
}

/**
 * The sub-tabs inside Settings › Connections (NEXT_PUBLIC_CONNECTORS_ENABLED; the layout leaves
 * them out while it is off). `connected` is how many connections are connected now, or null when
 * the count isn't known (the core switch is off, or the list didn't load).
 */
export function ConnectionsTabs({ connected }: { connected: number | null }) {
  const active = connectionsTabOf(usePathname());
  return (
    <nav aria-label="Connections" className="flex flex-wrap gap-x-5 border-b border-neutral-200 text-sm dark:border-neutral-800">
      {TABS.map((t) => {
        const on = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-0.5 py-2 ${
              on
                ? "border-neutral-900 font-medium text-neutral-900 dark:border-white dark:text-white"
                : "border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            }`}
          >
            {t.label}
            {t.key === "connected" && connected ? (
              <span className="rounded-full bg-neutral-200 px-1.5 text-xs font-medium text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100">{connected}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
