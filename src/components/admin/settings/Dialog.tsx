"use client";

import { useEffect, type ReactNode } from "react";

/**
 * A centred dialog for Settings (History's restore preview, Data model's erase): its question as
 * the heading, a line under it, then the body. Closes on Escape and a click outside, unless `busy`.
 */
export function Dialog({ title, sub, busy = false, onClose, children }: { title: string; sub?: ReactNode; busy?: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="presentation" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="mt-16 w-full max-w-xl space-y-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1">
          <h3 className="text-base font-semibold">{title}</h3>
          {sub ? <p className="text-sm text-neutral-500">{sub}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Label and lines, as the dialogs' tables show them. */
export function DialogTable({ rows }: { rows: Array<{ label: string; lines: string[]; note?: string }> }) {
  return (
    <dl className="divide-y divide-neutral-100 rounded-md border border-neutral-200 text-sm dark:divide-neutral-900 dark:border-neutral-800">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[8rem_1fr] gap-3 px-3 py-2.5">
          <dt className="text-neutral-500">{r.label}</dt>
          <dd className="space-y-1">
            {r.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
            {r.note ? <p className="text-xs text-neutral-500">{r.note}</p> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
