import type { CountRow } from "@/lib/analytics/analytics";

/** Horizontal bars, one per row (label · bar · count). Plain markup, server-safe. */
export function BarList({ rows }: { rows: CountRow[] }) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.value} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 tabular-nums text-neutral-500">{r.value}</span>
          <div className="h-4 flex-1 rounded bg-neutral-100 dark:bg-neutral-900">
            <div
              className="h-4 rounded bg-neutral-800 dark:bg-neutral-300"
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right tabular-nums">{r.count}</span>
        </div>
      ))}
    </div>
  );
}
