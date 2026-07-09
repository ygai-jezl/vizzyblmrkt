"use client";

import { formatUtc, type CalendarNewsletter } from "@/lib/distribute/uiModel";

const STATUS_STYLES: Record<string, string> = {
  scheduled:
    "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-300",
  sent: "border-green-300 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300",
  queued:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300",
  sending:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300",
};

/**
 * Read-only calendar/list chip for a weekly-newsletter broadcast. Renders
 * alongside the social PostCards so a scheduled/sent newsletter shows up in the
 * content calendar. Reschedule/cancel live in the Weekly tab, not here.
 */
export function NewsletterChip({ item }: { item: CalendarNewsletter }) {
  const tone =
    STATUS_STYLES[item.status] ??
    "border-neutral-300 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300";
  return (
    <div
      className={`rounded-md border px-2 py-1 text-[11px] ${tone}`}
      title={`Weekly newsletter · ${item.subject} · ${item.status}`}
    >
      <div className="flex items-center gap-1">
        <span aria-hidden>📰</span>
        <span className="truncate font-medium">{item.subject}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 opacity-80">
        <span className="capitalize">{item.status}</span>
        <span className="shrink-0">{formatUtc(item.dateIso)}</span>
      </div>
    </div>
  );
}
