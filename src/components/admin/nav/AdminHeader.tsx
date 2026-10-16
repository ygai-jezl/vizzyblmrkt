"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChevronRight } from "lucide-react";
import { openHowTo } from "@/components/help/openHowTo";
import { isSetupGuideEnabled } from "@/lib/help/flags";
import { helpFor } from "@/lib/help/places";
import { isInsightsHubEnabled, isNavV2Phase3Enabled, isThemeSwitchEnabled } from "@/lib/nav/flags";
import { breadcrumbsFor, type CrumbNames } from "@/lib/nav/model";
import { ThemeSwitch } from "./ThemeSwitch";

/** The slim bar above every admin page: where you are on the left, the theme switch on the right. */
export function AdminHeader({ names }: { names: CrumbNames }) {
  const pathname = usePathname() ?? "/admin";
  const crumbs = breadcrumbsFor(pathname, names, { phase3: isNavV2Phase3Enabled(), insights: isInsightsHubEnabled() });
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-4 border-b border-shell-line bg-shell-side px-6">
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {crumbs.map((crumb, i) => (
            <li key={`${i}:${crumb.label}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight size={13} aria-hidden className="shrink-0 text-shell-faint" />}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="truncate text-shell-muted hover:text-shell-ink"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current="page" className="truncate font-medium text-shell-ink">
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {isSetupGuideEnabled() ? (
        <button
          type="button"
          onClick={() => openHowTo(helpFor(pathname)) || window.open(helpFor(pathname), "_blank", "noopener")}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink"
        >
          <BookOpen size={15} aria-hidden />
          How to
        </button>
      ) : null}
      {isThemeSwitchEnabled() && <ThemeSwitch />}
    </header>
  );
}
