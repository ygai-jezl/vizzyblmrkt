"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";

interface Tab {
  href: string;
  label: string;
  /** Match the href exactly (Overview is the prefix of every tab). */
  exact?: boolean;
  /** Other paths this tab owns (e.g. Calendar owns the weekly newsletter). */
  also?: string[];
  /** Paths under `href` that belong to another tab. */
  not?: string[];
  /** Pushed to the right-hand side (Knowledge, Settings). */
  aside?: boolean;
}

/** Sub-tab strip for a workspace — the Content OS macro-pillars. Mirrors LaunchTabs. */
export function WorkspaceTabs({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/admin/workspace/${workspaceId}`;
  // Nav v2 phase 3: the tabs follow the pipeline — Ideas → Templates → Drafts →
  // Calendar — with Knowledge (was Grounding) and Settings apart.
  const tabs: Tab[] = isNavV2Phase3Enabled()
    ? [
        { href: base, label: "Overview", exact: true },
        { href: `${base}/curate/idea-board`, label: "Ideas", also: [`${base}/curate`], not: [`${base}/curate/grounding`] },
        { href: `${base}/templatize`, label: "Templates" },
        { href: `${base}/create`, label: "Drafts" },
        { href: `${base}/distribute`, label: "Calendar", also: [`${base}/weekly`] },
        { href: `${base}/curate/grounding`, label: "Knowledge", aside: true },
        { href: `${base}/settings`, label: "Settings", aside: true },
      ]
    : [
        { href: `${base}/curate`, label: "Curate" },
        { href: `${base}/templatize`, label: "Templatize" },
        { href: `${base}/create`, label: "Create" },
        { href: `${base}/distribute`, label: "Distribute" },
        { href: `${base}/weekly`, label: "Weekly" },
        { href: `${base}/settings`, label: "Settings" },
      ];
  const isActive = (t: Tab) => {
    const path = pathname ?? "";
    if (t.exact) return path === t.href;
    if (t.not?.some((n) => path.startsWith(n))) return false;
    return [t.href, ...(t.also ?? [])].some((h) => path.startsWith(h));
  };
  const firstAside = tabs.findIndex((t) => t.aside);

  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {tabs.map((t, i) => {
        const active = isActive(t);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`${i === firstAside ? "sm:ml-auto " : ""}rounded-md border px-3 py-1 ${
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
