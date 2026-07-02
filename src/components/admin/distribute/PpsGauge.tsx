"use client";

import { useState } from "react";

/**
 * Predictive Performance Score chip (0–100) with an expandable per-dimension
 * breakdown. Accepts the loose persisted shape (breakdown as a record) so it
 * renders both the live-computed score and a post's stored `pps`.
 */
function tone(score: number): string {
  if (score >= 75) return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (score >= 50) return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
}

export function PpsGauge({
  pps,
}: {
  pps: { score: number; breakdown: Record<string, number> };
}) {
  const [open, setOpen] = useState(false);
  const rows: Array<[string, string]> = [
    ["Hook", "hook"],
    ["Brevity", "brevity"],
    ["Formatting", "formatting"],
    ["Keywords", "keyword"],
  ];
  return (
    <div className="inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone(pps.score)}`}
        aria-expanded={open}
        title="Predictive Performance Score (pre-publish)"
      >
        PPS {pps.score}
      </button>
      {open ? (
        <div className="mt-1 w-56 space-y-1 text-[11px] text-neutral-500">
          {rows.map(([label, key]) => {
            // Clamp — a persisted breakdown (a free Record<string,number> from
            // Firestore) isn't range-validated, so guard the bar width.
            const v = Math.max(0, Math.min(100, pps.breakdown[key] ?? 0));
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="w-16">{label}</span>
                <span className="h-1.5 flex-1 rounded bg-neutral-200 dark:bg-neutral-800">
                  <span className="block h-1.5 rounded bg-neutral-500" style={{ width: `${v}%` }} />
                </span>
                <span className="w-6 text-right tabular-nums">{v}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
