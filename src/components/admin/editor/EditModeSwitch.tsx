"use client";

import { PenLine } from "lucide-react";

/**
 * The `Markdown | Edit mode` switch on a raw text box. The raw side is where you are; Edit mode
 * opens the rich editor over the screen. `raw` names the box's format ("Markdown", "HTML").
 */
export function EditModeSwitch({
  raw,
  onOpen,
  disabled,
}: {
  raw: string;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex gap-0.5 rounded-lg border border-neutral-200 bg-neutral-100 p-0.5 dark:border-neutral-800 dark:bg-neutral-900">
      <button
        type="button"
        aria-pressed="true"
        className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100"
      >
        {raw}
      </button>
      <button
        type="button"
        aria-pressed="false"
        onClick={onOpen}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        <PenLine size={13} aria-hidden />
        Edit mode
      </button>
    </span>
  );
}
