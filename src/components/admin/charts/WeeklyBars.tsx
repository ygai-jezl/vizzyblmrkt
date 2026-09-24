/**
 * One series of weekly counts as bars (nav v2 phase 4 Insights). Server-safe SVG,
 * no chart library. Follows the dataviz rules: a single series needs no legend
 * (the title names it); thin bars with a 2px surface gap and rounded data-ends
 * anchored to the baseline; a hover tooltip on every bar with a column-wide hit
 * target; only the latest value is labelled; a quiet baseline; and a table view.
 * Colours were checked with the dataviz palette validator: blue-600 on white and
 * blue-500 on the dark surface both pass (lightness band, chroma, 3:1 contrast).
 */

export interface WeeklyPoint {
  /** ISO date the week starts. */
  start: string;
  value: number | null;
}

const W = 640;
const H = 132;
const TOP = 18; // room for the latest value's label
const BASE = H - 18; // baseline; room for the date labels below
const GAP = 2;
const R = 4;

const fmtWeek = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** A bar with rounded top corners and a flat base on the baseline. */
function barPath(x: number, y: number, w: number): string {
  const h = BASE - y;
  const r = Math.min(R, w / 2, h);
  if (h <= 0) return "";
  return `M${x},${BASE} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${BASE} Z`;
}

export function WeeklyBars({ title, points, unit }: { title: string; points: WeeklyPoint[]; unit: string }) {
  const n = points.length;
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  const step = W / Math.max(n, 1);
  const barW = Math.max(2, step - GAP);
  const y = (v: number) => BASE - (v / max) * (BASE - TOP);
  const last = points[n - 1];
  const total = points.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <figure className="space-y-2">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-xs text-neutral-500">
          {total.toLocaleString("en-GB")} {unit} in {n} weeks
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label={`${title}: ${total} ${unit} over ${n} weeks`}>
        <line x1={0} x2={W} y1={BASE} y2={BASE} className="stroke-neutral-200 dark:stroke-neutral-800" strokeWidth={1} />
        {points.map((p, i) => {
          const x = i * step + GAP / 2;
          const label = `Week of ${fmtWeek(p.start)}: ${p.value == null ? "unknown" : `${p.value.toLocaleString("en-GB")} ${unit}`}`;
          return (
            <g key={p.start}>
              {p.value ? <path d={barPath(x, y(p.value), barW)} className="fill-blue-600 dark:fill-blue-500" /> : null}
              {/* The hover target is the whole column, bigger than the bar. */}
              <rect x={i * step} y={0} width={step} height={BASE} fill="transparent">
                <title>{label}</title>
              </rect>
            </g>
          );
        })}
        {last?.value != null ? (
          <text
            x={(n - 1) * step + step / 2}
            y={Math.max(12, y(last.value) - 5)}
            textAnchor="middle"
            className="fill-neutral-700 text-[11px] font-semibold dark:fill-neutral-200"
          >
            {last.value.toLocaleString("en-GB")}
          </text>
        ) : null}
        {n > 0 ? (
          <>
            <text x={0} y={H - 4} className="fill-neutral-500 text-[10px]">
              {fmtWeek(points[0]!.start)}
            </text>
            <text x={W} y={H - 4} textAnchor="end" className="fill-neutral-500 text-[10px]">
              this week
            </text>
          </>
        ) : null}
      </svg>
      <details className="text-xs text-neutral-500">
        <summary className="cursor-pointer select-none">Show as a table</summary>
        <table className="mt-2 w-full max-w-sm">
          <thead>
            <tr className="text-left">
              <th className="py-1 font-medium">Week of</th>
              <th className="py-1 text-right font-medium">{unit[0]!.toUpperCase() + unit.slice(1)}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.start} className="border-t border-neutral-100 dark:border-neutral-900">
                <td className="py-1">{fmtWeek(p.start)}</td>
                <td className="py-1 text-right tabular-nums">{p.value == null ? "—" : p.value.toLocaleString("en-GB")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
