"use client";

import { useState } from "react";
import { countVariants, SPINTAX_MAX_VARIANTS } from "@/lib/distribute/spintax";
import { SpintaxEditor } from "./SpintaxEditor";

/** A link that shows the current variant count and expands the SpintaxEditor. */
export function SpintaxToggle({
  initial,
  busy,
  onSave,
}: {
  initial: string;
  busy: boolean;
  onSave: (source: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const n = initial.trim() ? countVariants(initial) : 0;
  const label = open
    ? "Hide spintax"
    : n > 1
      ? `Spintax · ${n >= SPINTAX_MAX_VARIANTS ? "1M+" : n} variants`
      : "Add spintax";

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-neutral-500 underline-offset-2 hover:underline"
        aria-expanded={open}
      >
        {label}
      </button>
      {open ? (
        <div className="mt-2 max-w-md">
          <SpintaxEditor
            initial={initial}
            busy={busy}
            onSave={(s) => {
              onSave(s);
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
