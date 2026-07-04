"use client";

import { useState } from "react";
import {
  countVariants,
  previewVariants,
  validateSpintax,
  hasSpintax,
  SPINTAX_MAX_VARIANTS,
} from "@/lib/distribute/spintax";

/**
 * Editor for a post's spintax recycling template. Live-validates, shows the
 * variant count, and previews a few sample expansions. `onSave("")` clears it.
 */
export function SpintaxEditor({
  initial,
  busy,
  onSave,
}: {
  initial: string;
  busy: boolean;
  onSave: (source: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const validation = trimmed ? validateSpintax(trimmed) : ({ ok: true } as const);
  const count = validation.ok && trimmed ? countVariants(trimmed) : 0;
  const samples =
    validation.ok && trimmed && hasSpintax(trimmed) ? previewVariants(trimmed, 3, 7) : [];

  return (
    <div className="rounded-md border border-neutral-200 p-2 text-xs dark:border-neutral-800">
      <div className="mb-1 font-medium text-neutral-700 dark:text-neutral-300">
        Spintax — recycle with {"{a|b|c}"} variants
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        placeholder="{Hi|Hello} — write {options|alternatives} to recycle without duplicate content"
        className="w-full rounded border border-neutral-300 p-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
      />
      {!validation.ok ? (
        <div className="mt-1 text-red-600">Invalid template: {validation.error}</div>
      ) : trimmed ? (
        <div className="mt-1 text-neutral-500">
          {count >= SPINTAX_MAX_VARIANTS ? "1,000,000+" : count.toLocaleString()} variant
          {count === 1 ? "" : "s"}
        </div>
      ) : null}
      {samples.length ? (
        <ul className="mt-1 space-y-0.5 text-neutral-500">
          {samples.map((s, i) => (
            <li key={i} className="truncate">
              • {s}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy || !validation.ok}
          onClick={() => onSave(value)}
          className="rounded bg-neutral-900 px-2 py-1 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          Save variants
        </button>
        {initial.trim() ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setValue("");
              onSave("");
            }}
            className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700"
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
