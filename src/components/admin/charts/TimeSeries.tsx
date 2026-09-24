import type { CountRow } from "@/lib/analytics/analytics";

/**
 * Minimal inline-SVG trend line (chronological day → count). Hand-rolled to keep
 * the analytics view a pure server component with zero client/charting deps,
 * matching the existing Stat/BarList/UtmTable style. Rows are assumed sorted
 * chronologically (the analytics layer sorts them).
 */
export function TimeSeries({ rows, label }: { rows: CountRow[]; label: string }) {
  const W = 640;
  const H = 96;
  const PAD = 6;
  const n = rows.length;
  const max = Math.max(...rows.map((r) => r.count), 1);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const px = (i: number) => (n <= 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1));
  const py = (c: number) => H - PAD - (c / max) * (H - 2 * PAD);
  const line = rows.map((r, i) => `${px(i).toFixed(1)},${py(r.count).toFixed(1)}`).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${px(n - 1).toFixed(1)},${H - PAD}`;
  const first = rows[0]?.value ?? "";
  const last = rows[n - 1]?.value ?? "";
  return (
    <div className="space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${total} ${label} over ${n} day${n === 1 ? "" : "s"}`}
      >
        <polygon points={area} className="fill-neutral-200/60 dark:fill-neutral-800/60" />
        <polyline
          points={line}
          className="fill-none stroke-neutral-800 dark:stroke-neutral-200"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-[10px] tabular-nums text-neutral-400">
        <span>{first}</span>
        <span>
          {total.toLocaleString()} {label} · peak {max.toLocaleString()}/day
        </span>
        <span>{last}</span>
      </div>
    </div>
  );
}
