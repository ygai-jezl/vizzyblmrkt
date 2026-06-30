"use client";

import { useState } from "react";
import { CHANNELS, channelLabel } from "@/lib/content/channels";
import type { ContentNodeType } from "@/lib/types/contentPlan";

/**
 * Slim, collapsible node palette docked to the left edge of the canvas (rendered
 * inside a React Flow <Panel>). Collapsed = a thin "＋" rail; expanded = a menu of
 * node types to add. Adding a node drops an empty node on the canvas; the operator
 * then wires it by dragging from a handle and configures it in the inspector.
 */
const SPOKE_CHANNELS = CHANNELS.filter((c) => !["newsletter", "blog", "standalone"].includes(c.id));

export function AddNodePalette({
  onAdd,
}: {
  onAdd: (type: ContentNodeType, channel: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Add node"
        className="flex h-10 w-9 items-center justify-center rounded-md border border-neutral-300 bg-white text-lg shadow-sm hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        ＋
      </button>
    );
  }

  return (
    <div className="w-52 rounded-md border border-neutral-300 bg-white p-3 shadow-md dark:border-neutral-700 dark:bg-neutral-900">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold">Add node</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-0.5 text-neutral-400 hover:text-neutral-700"
          aria-label="Close palette"
        >
          ✕
        </button>
      </div>

      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">Spoke</div>
      <div className="mb-3 flex flex-wrap gap-1">
        {SPOKE_CHANNELS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onAdd("spoke", c.id)}
            className="rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            → {channelLabel(c.id)}
          </button>
        ))}
      </div>

      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-400">Promo</div>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onAdd("promo_pre", "linkedin")}
          className="rounded border border-neutral-300 px-2 py-1 text-left text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          ✦ Pre-hub teaser
        </button>
        <button
          type="button"
          onClick={() => onAdd("promo_post", "linkedin")}
          className="rounded border border-neutral-300 px-2 py-1 text-left text-[11px] hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          ✦ Post-hub promo
        </button>
      </div>

      <p className="mt-3 text-[10px] leading-snug text-neutral-400">
        Drag from a node&apos;s dots to connect it. Click a node to pick its template.
      </p>
    </div>
  );
}
