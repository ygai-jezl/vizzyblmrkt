import Link from "next/link";
import { Check } from "lucide-react";
import type { LaunchChecklistStep } from "@/lib/nav/launchChecklist";

/** A launch's Overview checklist (nav v2 phase 4). Server-safe. */
export function LaunchChecklist({ steps }: { steps: LaunchChecklistStep[] }) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" aria-label="Launch checklist">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Launch checklist</h2>
        <span className="text-xs text-neutral-500">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-900">
        {steps.map((s) => {
          const isNext = s === next;
          return (
            <li key={s.key} className="flex items-center gap-3 py-2">
              <span
                aria-hidden
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
                  s.done
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : isNext
                      ? "border-blue-500 ring-2 ring-blue-100 dark:ring-blue-950"
                      : "border-neutral-300 dark:border-neutral-700"
                }`}
              >
                {s.done ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${s.done ? "text-neutral-500" : "font-medium"}`}>
                  {s.label}
                  <span className="sr-only">{s.done ? " (done)" : ""}</span>
                </p>
                <p className="truncate text-xs text-neutral-500">{s.detail}</p>
              </div>
              {!s.done ? (
                <Link
                  href={s.href}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium ${
                    isNext
                      ? "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
                      : "border border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  }`}
                >
                  {isNext ? "Do this next" : "Open"}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
