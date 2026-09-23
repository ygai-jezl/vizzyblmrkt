"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { isThemeSwitchEnabled } from "@/lib/nav/flags";
import { breadcrumbsFor, type CrumbNames } from "@/lib/nav/model";
import { ThemeSwitch } from "./ThemeSwitch";

/** The slim bar above every admin page: where you are on the left, the theme switch on the right. */
export function AdminHeader({ names }: { names: CrumbNames }) {
  const pathname = usePathname() ?? "/admin";
  const crumbs = breadcrumbsFor(pathname, names);
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-4 border-b border-neutral-200 bg-white/90 px-6 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {crumbs.map((crumb, i) => (
            <li key={`${i}:${crumb.label}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight size={13} aria-hidden className="shrink-0 text-neutral-400" />}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="truncate text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current="page" className="truncate font-medium text-neutral-900 dark:text-neutral-100">
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
