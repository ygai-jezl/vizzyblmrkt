"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { isNavV2Phase3Enabled, isThemeSwitchEnabled } from "@/lib/nav/flags";
import { breadcrumbsFor, type CrumbNames } from "@/lib/nav/model";
import { ThemeSwitch } from "./ThemeSwitch";

/** The slim bar above every admin page: where you are on the left, the theme switch on the right. */
export function AdminHeader({ names }: { names: CrumbNames }) {
  const pathname = usePathname() ?? "/admin";
  const crumbs = breadcrumbsFor(pathname, names, { phase3: isNavV2Phase3Enabled() });
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
      {isThemeSwitchEnabled() && <ThemeSwitch />}
    </header>
  );
}
