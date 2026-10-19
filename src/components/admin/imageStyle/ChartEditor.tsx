"use client";

import type { ChartDraft } from "./chartDraft";

const INPUT = "min-w-0 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900";

/**
 * Data story's "Numbers on the image": a row per point (label and number, as you'd write it),
 * the chart's shape and an optional source. Up to 12 rows.
 */
export function ChartEditor({
  draft,
  onChange,
  disabled,
  note,
}: {
  draft: ChartDraft;
  onChange: (next: ChartDraft) => void;
  disabled?: boolean;
  /** One line under the title ("Found in your post. Edit any."). */
  note?: string;
}) {
  const setRow = (i: number, patch: Partial<ChartDraft["rows"][number]>) =>
    onChange({ ...draft, rows: draft.rows.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  return (
    <div className="mt-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
      <div className="text-[10px] uppercase tracking-wide text-neutral-400">Numbers on the image</div>
      {note ? <p className="mt-0.5 text-[10px] text-neutral-500">{note}</p> : null}
      <div className="mt-1 space-y-1">
        {draft.rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1">
            <input
              aria-label={`Label ${i + 1}`}
              value={r.label}
              maxLength={40}
              disabled={disabled}
              onChange={(e) => setRow(i, { label: e.target.value })}
              placeholder="Label (28 Sep)"
              className={`${INPUT} flex-1`}
            />
            <input
              aria-label={`Number ${i + 1}`}
              value={r.value}
              maxLength={16}
              disabled={disabled}
              onChange={(e) => setRow(i, { value: e.target.value })}
              placeholder="100%"
              className={`${INPUT} w-20`}
            />
            <button
              type="button"
              aria-label={`Remove ${i + 1}`}
              disabled={disabled || draft.rows.length <= 2}
              onClick={() => onChange({ ...draft, rows: draft.rows.filter((_, k) => k !== i) })}
              className="px-1 text-xs text-neutral-400 hover:text-neutral-700 disabled:opacity-30"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      {draft.rows.length < 12 ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ ...draft, rows: [...draft.rows, { label: "", value: "" }] })}
          className="mt-1 text-[11px] text-neutral-600 hover:text-neutral-900 dark:text-neutral-300"
        >
          + Add a number
        </button>
      ) : null}
      <div className="mt-1 flex items-center gap-1">
        <select
          aria-label="Chart"
          value={draft.kind}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as ChartDraft["kind"] })}
          className={INPUT}
        >
          <option value="line">Line</option>
          <option value="bar">Bars</option>
          <option value="compare">Before and after</option>
        </select>
        <input
          aria-label="Source"
          value={draft.source}
          maxLength={120}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, source: e.target.value })}
          placeholder="Source (optional)"
          className={`${INPUT} flex-1`}
        />
      </div>
    </div>
  );
}
