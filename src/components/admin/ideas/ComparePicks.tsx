"use client";

import { useEffect, useRef, useState } from "react";
import { COMPARE_MAX, COMPARE_MIN } from "@/lib/ideas/list";

/**
 * The bar above the launches list's compare boxes (LAUNCH_IDEAS_ENABLED). The boxes are plain
 * `compare` checkboxes in a GET form, so Compare side by side is the browser's own submit to
 * `?compare=a&compare=b`; this only counts the ticks, turns the other boxes off at four, and clears
 * them.
 */
export function ComparePicks() {
  const ref = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState(0);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const boxes = () => Array.from(form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name="compare"]'));
    const update = () => {
      const n = boxes().filter((b) => b.checked).length;
      for (const b of boxes()) b.disabled = n >= COMPARE_MAX && !b.checked;
      setPicked(n);
    };
    // A reset clears the boxes after its event, so count once it has.
    const afterReset = () => setTimeout(update);
    update();
    form.addEventListener("change", update);
    form.addEventListener("reset", afterReset);
    return () => {
      form.removeEventListener("change", update);
      form.removeEventListener("reset", afterReset);
    };
  }, []);

  const ready = picked >= COMPARE_MIN;
  return (
    <div ref={ref} role="status" className={`flex flex-wrap items-center justify-between gap-2 text-sm ${ready ? "rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900" : "text-neutral-500"}`}>
      <p>
        {ready
          ? `${picked} launches picked.${picked >= COMPARE_MAX ? " That's the most you can compare at once." : ""}`
          : picked === 1
            ? "1 launch picked. Tick one more to compare them."
            : `Tick ${COMPARE_MIN} to ${COMPARE_MAX} launches to compare them side by side.`}
      </p>
      {ready ? (
        <span className="flex gap-2">
          <button type="reset" className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900">
            Clear
          </button>
          <button type="submit" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200">
            Compare side by side
          </button>
        </span>
      ) : null}
    </div>
  );
}
