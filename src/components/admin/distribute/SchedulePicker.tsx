"use client";

import { useState } from "react";

/**
 * A `datetime-local` input + action button. The local wall-clock value is
 * converted to a UTC ISO instant on submit (the schedule route requires a
 * tz-aware instant). Empty/invalid input is ignored.
 */
export function SchedulePicker({
  label,
  initial,
  disabled,
  onSubmit,
}: {
  label: string;
  initial?: string;
  disabled?: boolean;
  onSubmit: (iso: string) => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  return (
    <div className="flex items-center gap-2">
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
      />
      <button
        type="button"
        disabled={disabled || !value}
        onClick={() => {
          const ms = new Date(value).getTime();
          if (Number.isNaN(ms)) return;
          onSubmit(new Date(ms).toISOString());
        }}
        className="rounded bg-neutral-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
      >
        {label}
      </button>
    </div>
  );
}
