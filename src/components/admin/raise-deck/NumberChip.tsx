"use client";

import { useState } from "react";
import { isPending } from "@/lib/raise/docs/edit";
import type { MetricBlock } from "@/lib/raise/docs/types";
import { LABEL_WORDS, NUMBER_DIALOG } from "@/lib/raise/docs/words";
import { blockLabel } from "./layouts/parts";

/** What a chip reads: the figure, or that it fills when the slide is saved, or its name. */
export function chipText(b: MetricBlock): string {
  if (isPending(b)) return LABEL_WORDS.fillsOnSave;
  return b.display || b.name;
}

/**
 * A number in the slide's words, as a chip: open it to see its name, figure, period and where it
 * came from ("Seen by YouGrow, 26 Nov", "Typed by you, 26 Nov", "said in chat"), and remove it.
 */
export function NumberChip({ block, part = "display", now, canEdit, onRemove }: { block: MetricBlock | undefined; part?: "display" | "period"; now: Date; canEdit: boolean; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  if (!block) return null;
  const text = part === "period" ? block.periodWords || block.name : chipText(block);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mx-0.5 inline-flex items-center rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100"
      >
        {text}
      </button>
      {open ? (
        <span
          role="dialog"
          aria-label={block.name}
          className="absolute left-0 top-full z-20 mt-1 block w-64 space-y-1 rounded-md border border-neutral-200 bg-white p-3 text-xs shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          <span className="block font-semibold">{block.name}</span>
          {block.display ? <span className="block text-base font-semibold">{block.display}</span> : null}
          {block.periodWords ? <span className="block text-neutral-500">{block.periodWords}</span> : null}
          <span className="block text-neutral-500">{blockLabel(block, now)}</span>
          {canEdit && onRemove ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
              className="mt-1 text-red-700 hover:underline dark:text-red-400"
            >
              {NUMBER_DIALOG.remove}
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
