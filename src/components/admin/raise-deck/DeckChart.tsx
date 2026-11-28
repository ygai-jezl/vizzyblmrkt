import { niceMax } from "@/lib/content/imageStyle/render/templates/dataStory";
import type { DeckTheme } from "@/lib/raise/docs/theme";
import { formatNumber } from "@/lib/raise/docs/text";
import type { MetricBlock } from "@/lib/raise/docs/types";
import { LABEL_WORDS } from "@/lib/raise/docs/words";

/**
 * A series block as a line chart: one point a week or a month, labelled axes and a source line
 * under it ("Sign-ups a week, 12 weeks to 23 Nov. Seen by YouGrow."). Inline SVG with real text, so
 * the PDF keeps the labels as text. No hooks.
 */

/** The line under a chart: what it shows, its period and where it came from. */
export function chartSource(b: Pick<MetricBlock, "name" | "periodWords" | "source">): string {
  const what = b.periodWords ? `${b.name}, ${b.periodWords}` : b.name;
  if (b.source.kind !== "typed") return `${what}. ${LABEL_WORDS.seen}.`;
  return b.source.from ? `${what}. ${LABEL_WORDS.typed}, from ${b.source.from}.` : `${what}. ${LABEL_WORDS.typed}.`;
}

export function DeckChart({ block, theme, width, height }: { block: MetricBlock; theme: DeckTheme; width: number; height: number }) {
  const pts = block.series ?? [];
  const sourceH = 32;
  const axisW = 64;
  const axisH = 36;
  const plotW = width - axisW - 12;
  const plotH = height - axisH - sourceH - 12;
  const top = niceMax(Math.max(0, ...pts.map((p) => p.value)));
  const x = (i: number) => axisW + (pts.length <= 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const y = (v: number) => 8 + plotH - (Math.max(0, v) / top) * plotH;
  const ticks = [0, top / 2, top];
  const labelAt = pts.length <= 3 ? pts.map((_, i) => i) : [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  const font = { fontFamily: theme.bodyFont, fill: theme.muted } as const;
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chartSource(block)} style={{ display: "block" }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={axisW} x2={axisW + plotW} y1={y(t)} y2={y(t)} stroke="#E4E4E0" strokeWidth={t === 0 ? 2 : 1} />
          <text x={axisW - 12} y={y(t) + 6} textAnchor="end" fontSize={17} {...font}>
            {formatNumber(t)}
          </text>
        </g>
      ))}
      {pts.length > 1 ? <polyline points={line} fill="none" stroke={theme.accentText} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" /> : null}
      {pts.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.value)} r={i === pts.length - 1 ? 8 : 5} fill={theme.accentText} />
      ))}
      {labelAt.map((i) => (
        <text key={i} x={x(i)} y={8 + plotH + 28} textAnchor={i === 0 && pts.length > 1 ? "start" : i === pts.length - 1 && pts.length > 1 ? "end" : "middle"} fontSize={17} {...font}>
          {pts[i]!.label}
        </text>
      ))}
      <text x={axisW} y={height - 8} fontSize={17} {...font}>
        {chartSource(block)}
      </text>
    </svg>
  );
}
