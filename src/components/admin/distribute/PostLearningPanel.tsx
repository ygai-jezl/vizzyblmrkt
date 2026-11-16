"use client";

import { useState } from "react";
import { useVizzyLearning } from "@/components/admin/editor/vizzy/useVizzyLearning";
import { VizzyMemories } from "@/components/admin/editor/vizzy/VizzyMemories";

/**
 * "What Vizzy remembers about how you edit" on Distribute (DISTRIBUTE_LEARN_FROM_EDITS_ENABLED):
 * the same list, Forget and "Learn from my edits" as Edit mode's Vizzy tab. Loaded only when
 * opened, so Distribute doesn't ask Memory Bank on every visit.
 */
export function PostLearningPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-left font-medium text-neutral-800 hover:underline dark:text-neutral-200"
      >
        What Vizzy remembers about how you edit
      </button>
      <p className="mt-0.5 text-xs text-neutral-500">
        Vizzy learns from the words you change in its LinkedIn and X posts and uses that in your next drafts.
      </p>
      {open ? (
        <div className="mt-3">
          <Memories />
        </div>
      ) : null}
    </div>
  );
}

function Memories() {
  const learning = useVizzyLearning(true);
  if (!learning.available) {
    return <p className="text-xs text-neutral-500">Loading what Vizzy remembers.</p>;
  }
  return <VizzyMemories learning={learning} />;
}
