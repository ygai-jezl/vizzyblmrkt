import type { ReactElement } from "react";
import { Brand, Headline, headlineLength, headlineWords, isLandscape, pointText, rgba, sizeFor, type TemplateInput } from "./shared";
import type { Chart } from "@/lib/types/imageStyle";

const PAPER = "#F5F2EA";
const INK = "#151515";
const MUTED = "#5F5A50";
const GRID = "#DDD6C8";

/** A round top for the axis: 1, 2, 2.5 or 5 times a power of ten, at or above `max`. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function lineChart(chart: Chart, box: Box, accent: string, unit: number, font: string): ReactElement[] {
  const pts = chart.points;
  const top = niceMax(Math.max(...pts.map((p) => p.value)));
  const axisW = unit * 9;
  const plot = { x: box.x + axisW, y: box.y + unit * 3, w: box.w - axisW, h: box.h - unit * 8 };
  const xy = pts.map((p, i) => ({
    x: plot.x + (pts.length === 1 ? plot.w / 2 : (i * plot.w) / (pts.length - 1)),
    y: plot.y + plot.h * (1 - Math.max(0, p.value) / top),
  }));
  const hi = chart.highlight ?? pts.reduce((best, p, i) => (p.value > pts[best]!.value ? i : best), 0);
  const d = xy.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const label = (text: string, x: number, y: number, align: "start" | "middle" | "end", style: Record<string, string | number>) => (
    <div
      key={`${text}${x}${y}`}
      style={{
        position: "absolute",
        display: "flex",
        top: y,
        left: align === "start" ? x : align === "middle" ? x - unit * 20 : x - unit * 40,
        width: align === "middle" ? unit * 40 : unit * 40,
        justifyContent: align === "start" ? "flex-start" : align === "middle" ? "center" : "flex-end",
        fontFamily: font,
        ...style,
      }}
    >
      {text}
    </div>
  );
  const ticks = [top, top / 2, 0];
  const showLabel = (i: number) => pts.length <= 6 || i === 0 || i === pts.length - 1 || i === hi;
  const anno = `${pts[hi]!.label}: ${pointText(pts[hi]!, chart.unit)}`;
  const annoLeft = Math.min(Math.max(xy[hi]!.x - unit * 20, box.x), box.x + box.w - unit * 40);
  return [
    <svg key="svg" style={{ position: "absolute", left: 0, top: 0 }} width={box.x + box.w + unit * 8} height={box.y + box.h} viewBox={`0 0 ${box.x + box.w + unit * 8} ${box.y + box.h}`}>
      {ticks.map((t, i) => (
        <line key={i} x1={plot.x} x2={plot.x + plot.w} y1={plot.y + (plot.h * i) / 2} y2={plot.y + (plot.h * i) / 2} stroke={GRID} strokeWidth={Math.max(1, unit * 0.18)} {...(i === 2 ? {} : { strokeDasharray: "3 4" })} />
      ))}
      <path d={d} stroke={INK} strokeWidth={unit * 0.45} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      {xy.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === hi ? unit * 1.1 : unit * 0.55} fill={i === hi ? accent : INK} stroke={PAPER} strokeWidth={unit * 0.4} />
      ))}
    </svg>,
    ...ticks.map((t, i) =>
      label(pointText({ label: "", value: t }, chart.unit), plot.x - unit * 1.5, plot.y + (plot.h * i) / 2 - unit * 1.2, "end", { fontSize: unit * 1.9, color: "#7A7468" }),
    ),
    ...pts.flatMap((p, i) => (showLabel(i) ? [label(short(p.label, 16), xy[i]!.x, plot.y + plot.h + unit * 1.4, i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle", { fontSize: unit * 2, color: "#7A7468" })] : [])),
    <div
      key="anno"
      style={{
        position: "absolute",
        display: "flex",
        left: annoLeft,
        width: unit * 40,
        top: Math.max(box.y - unit * 0.5, xy[hi]!.y - unit * 5),
        justifyContent: "center",
        fontFamily: font,
        fontSize: unit * 2.3,
        fontWeight: 600,
        color: INK,
      }}
    >
      <span style={{ background: PAPER, padding: `0 ${unit * 0.6}px` }}>{anno}</span>
    </div>,
  ];
}

function barChart(chart: Chart, box: Box, accent: string, unit: number, font: string): ReactElement[] {
  const pts = chart.points;
  const top = niceMax(Math.max(...pts.map((p) => p.value)));
  const hi = chart.highlight ?? pts.reduce((best, p, i) => (p.value > pts[best]!.value ? i : best), 0);
  const slot = box.w / pts.length;
  const barW = Math.min(slot * 0.62, unit * 18);
  const base = box.y + box.h - unit * 6;
  const room = base - box.y - unit * 5;
  return pts.flatMap((p, i) => {
    const h = Math.max(unit * 0.4, (room * Math.max(0, p.value)) / top);
    const x = box.x + slot * i + (slot - barW) / 2;
    const colour = i === hi ? accent : rgba(INK, 0.82);
    return [
      <div key={`b${i}`} style={{ position: "absolute", display: "flex", left: x, top: base - h, width: barW, height: h, background: colour, borderRadius: unit * 0.4 }} />,
      <div
        key={`v${i}`}
        style={{ position: "absolute", display: "flex", justifyContent: "center", left: x - unit * 6, width: barW + unit * 12, top: base - h - unit * 4.2, fontFamily: font, fontSize: unit * (pts.length > 6 ? 2.2 : 2.8), fontWeight: 600, color: i === hi ? accent : INK }}
      >
        {pointText(p, chart.unit)}
      </div>,
      <div
        key={`l${i}`}
        style={{ position: "absolute", display: "flex", justifyContent: "center", textAlign: "center", left: box.x + slot * i, width: slot, top: base + unit * 1.2, fontFamily: font, fontSize: unit * 2, color: MUTED }}
      >
        {short(p.label, Math.max(6, Math.floor(slot / (unit * 1.1))))}
      </div>,
    ];
  }).concat([<div key="base" style={{ position: "absolute", display: "flex", left: box.x, top: base, width: box.w, height: Math.max(2, Math.round(unit * 0.2)), background: "#CFC8B8" }} />]);
}

function compareChart(chart: Chart, box: Box, accent: string, unit: number, font: string, heading: string): ReactElement[] {
  const [a, b] = chart.points as [Chart["points"][number], Chart["points"][number]];
  const top = Math.max(a.value, b.value, 1);
  const hi = chart.highlight ?? (b.value >= a.value ? 1 : 0);
  const rowH = box.h / 2;
  return [a, b].flatMap((p, i) => {
    const y = box.y + rowH * i + unit * 1;
    const colour = i === hi ? accent : INK;
    return [
      <div key={`l${i}`} style={{ position: "absolute", display: "flex", left: box.x, top: y, fontFamily: font, fontSize: unit * 2.1, letterSpacing: "0.12em", textTransform: "uppercase", color: MUTED }}>
        {short(p.label, 32)}
      </div>,
      <div key={`v${i}`} style={{ position: "absolute", display: "flex", left: box.x, top: y + unit * 3, fontFamily: heading, fontWeight: 700, fontSize: Math.min(rowH * 0.5, unit * 11), lineHeight: 1, letterSpacing: "-0.03em", color: colour }}>
        {pointText(p, chart.unit)}
      </div>,
      <div
        key={`b${i}`}
        style={{ position: "absolute", display: "flex", left: box.x, top: y + rowH - unit * 4, height: unit * 1.4, width: Math.max(unit * 1.4, (box.w * Math.max(0, p.value)) / top), background: colour, borderRadius: unit }}
      />,
    ];
  });
}

/**
 * 03 Data story: warm paper, a serif headline, and one chart of the copy's own numbers (a line
 * over time, bars side by side, or a before and after), the key value in the accent and
 * annotated, with its source. Without a chart it draws the headline alone (the routes step
 * down before that).
 */
export function dataStory(i: TemplateInput): ReactElement {
  const { width: W, height: H } = i;
  const land = isLandscape(i);
  const unit = Math.min(W, H) / 100;
  const pad = land ? { x: W * 0.058, y: H * 0.074 } : { x: W * 0.074, y: W * 0.074 };
  const size = sizeFor(headlineLength(i.headline), unit * (land ? 7.2 : 8.4), unit * 4.2);
  const chart = i.chart ?? null;
  const footerH = unit * 5;
  // Where the chart starts: under the headline, which takes less of a tall frame.
  const chartTop = land ? 0.36 : H > W ? 0.34 : 0.44;
  const box: Box = {
    x: pad.x,
    y: H * chartTop,
    w: W - pad.x * 2,
    h: H - pad.y - footerH - H * chartTop,
  };
  const parts = !chart
    ? []
    : chart.kind === "compare" && chart.points.length === 2
      ? compareChart(chart, box, i.accent, unit, i.fonts.body, i.fonts.heading)
      : chart.kind === "bar"
        ? barChart(chart, box, i.accent, unit, i.fonts.body)
        : lineChart(chart, box, i.accent, unit, i.fonts.body);

  return (
    <div style={{ display: "flex", position: "relative", width: W, height: H, background: PAPER, color: INK, fontFamily: i.fonts.body, overflow: "hidden" }}>
      <div style={{ position: "absolute", display: "flex", left: pad.x, top: pad.y, width: W - pad.x * 2, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", fontSize: unit * 2, letterSpacing: "0.14em", textTransform: "uppercase", color: MUTED }}>{i.eyebrow ?? ""}</div>
        {i.showLogo !== false ? <Brand logo={i.logo} brandName={i.brandName} height={unit * 4.6} color={INK} font={i.fonts.heading} /> : <div style={{ display: "flex" }} />}
      </div>
      <div style={{ position: "absolute", display: "flex", flexDirection: "column", left: pad.x, top: pad.y + unit * 8, width: W - pad.x * 2 }}>
        <Headline
          words={headlineWords(i.headline)}
          size={size}
          color={INK}
          highlight={{ color: i.accent }}
          style={{ fontFamily: i.fonts.heading, fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.06, ...(land ? { maxWidth: W * 0.8 } : {}) }}
        />
        {i.subline ? <div style={{ display: "flex", marginTop: unit * 1.6, fontSize: unit * 2.4, color: MUTED }}>{i.subline}</div> : null}
      </div>
      {parts}
      <div style={{ position: "absolute", display: "flex", left: pad.x, bottom: pad.y * 0.7, width: W - pad.x * 2, justifyContent: "space-between", fontSize: unit * 2, color: "#6F6A60" }}>
        <div style={{ display: "flex" }}>{chart?.source ? `Source: ${chart.source}` : ""}</div>
        <div style={{ display: "flex" }}>{i.footer ?? ""}</div>
      </div>
    </div>
  );
}
