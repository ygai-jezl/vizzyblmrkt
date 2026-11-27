import Link from "next/link";
import type { ReactNode } from "react";
import { tasksTabLabel } from "@/lib/work/screenWords";

/** Work's two tabs, Tasks and Log, as links: the address says which is open. */
export function WorkTabs({ active, openCount }: { active: "tasks" | "log"; openCount: number | null }) {
  const tabs = [
    { key: "tasks", label: tasksTabLabel(openCount), href: "/admin/work" },
    { key: "log", label: "Log", href: "/admin/work/log" },
  ] as const;
  return (
    <nav aria-label="Work" className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${
            active === t.key
              ? "border-neutral-900 font-medium text-neutral-900 dark:border-white dark:text-white"
              : "border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Work's title, the line under it, and the buttons on the right. */
export function WorkHeader({ sub, actions }: { sub: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">Work</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{sub}</p>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A note above a Work screen: who sees what, a region that didn't answer. */
export function WorkNote({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return (
    <p
      role={tone === "warn" ? "status" : "note"}
      className={`rounded-md border px-3 py-2 text-sm ${
        tone === "warn"
          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          : "border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
      }`}
    >
      {children}
    </p>
  );
}

/** Work can't tell whose tasks to show: the words for why. */
export function WorkUnavailable({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">Work</h1>
      <WorkNote tone="warn">{message}</WorkNote>
    </div>
  );
}
