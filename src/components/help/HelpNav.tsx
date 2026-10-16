"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Group {
  key: string;
  label: string;
  pages: Array<{ path: string; label: string }>;
}

/** The help navigation, grouped by setup stage, with the open page marked. */
export function HelpNav({ groups }: { groups: Group[] }) {
  // On a phone the list folds away, so the page itself comes first.
  return (
    <>
      <details className="rounded-md border border-neutral-200 px-3 py-2 md:hidden dark:border-neutral-800">
        <summary className="cursor-pointer font-medium">All help pages</summary>
        <div className="mt-3">
          <List groups={groups} />
        </div>
      </details>
      <div className="hidden md:block">
        <List groups={groups} />
      </div>
    </>
  );
}

function List({ groups }: { groups: Group[] }) {
  const pathname = usePathname();
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.key}>
          {g.label ? (
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{g.label}</p>
          ) : null}
          <ul className="space-y-0.5">
            {g.pages.map((p) => {
              const here = pathname === p.path;
              return (
                <li key={p.path}>
                  <Link
                    href={p.path}
                    aria-current={here ? "page" : undefined}
                    className={`block rounded-md px-2 py-1 ${
                      here
                        ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white"
                        : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
                    }`}
                  >
                    {p.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
