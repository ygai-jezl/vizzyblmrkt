import { ChartSchema, type Chart } from "@/lib/types/imageStyle";

/**
 * The Numbers editor's working copy of a Data story chart: rows of text the person types, made
 * a chart when two or more rows have a label and a number. Pure, so it's tested on its own.
 */
export interface ChartDraft {
  kind: Chart["kind"];
  unit: string;
  source: string;
  rows: { label: string; value: string }[];
}

export const EMPTY_DRAFT: ChartDraft = { kind: "line", unit: "", source: "", rows: [{ label: "", value: "" }, { label: "", value: "" }] };

export function draftFromChart(chart: Chart): ChartDraft {
  return {
    kind: chart.kind,
    unit: chart.unit,
    source: chart.source ?? "",
    rows: chart.points.map((p) => ({ label: p.label, value: p.display ?? String(p.value) })),
  };
}

/** "4,235" → 4235, "42%" → 42, "$1.2m" → 1.2; null when there's no number. */
export function numberOf(text: string): number | null {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text.replace(/\s/g, ""));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** The chart the draft makes, or null while fewer than two rows are complete. */
export function chartFromDraft(draft: ChartDraft | null): Chart | null {
  if (!draft) return null;
  const points = draft.rows
    .map((r) => ({ label: r.label.trim(), value: numberOf(r.value), display: r.value.trim() }))
    .filter((p): p is { label: string; value: number; display: string } => Boolean(p.label) && p.value !== null)
    .slice(0, 12)
    .map((p) => ({ label: p.label.slice(0, 40), value: p.value, ...(p.display && p.display !== String(p.value) ? { display: p.display.slice(0, 16) } : {}) }));
  const kind = draft.kind === "compare" && points.length !== 2 ? "bar" : draft.kind;
  const parsed = ChartSchema.safeParse({ kind, unit: draft.unit.trim().slice(0, 12), points, ...(draft.source.trim() ? { source: draft.source.trim().slice(0, 120) } : {}) });
  return parsed.success ? parsed.data : null;
}
