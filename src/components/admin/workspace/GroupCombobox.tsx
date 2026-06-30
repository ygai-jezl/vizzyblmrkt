"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Search + create-new group selector. Lists existing groups (filtered by the
 * query) and offers a "Create …" row when the typed text matches none — the
 * type-to-create pattern, used on the Idea Board reveal and template cards.
 */
export function GroupCombobox({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Reset the search query whenever the dropdown closes (any path).
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const q = query.trim();
  const filtered = options.filter((o) => o.toLowerCase().includes(q.toLowerCase()));
  const canCreate = Boolean(q) && !options.some((o) => o.toLowerCase() === q.toLowerCase());

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200"
      >
        {value || "Set group"} <span className="text-neutral-400">▾</span>
      </button>
      {open ? (
        <div className="absolute z-20 mt-1 w-56 rounded-md border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or create…"
            className="mb-1 w-full rounded border border-neutral-200 px-2 py-1 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-800"
          />
          <div className="max-h-48 overflow-auto">
            {filtered.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => pick(o)}
                className={`block w-full rounded px-2 py-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                  o === value ? "font-medium text-violet-700 dark:text-violet-300" : ""
                }`}
              >
                {o}
              </button>
            ))}
            {canCreate ? (
              <button
                type="button"
                onClick={() => pick(q)}
                className="block w-full rounded px-2 py-1 text-left text-xs text-violet-700 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/40"
              >
                ➕ Create “{q}”
              </button>
            ) : null}
            {!filtered.length && !canCreate ? (
              <div className="px-2 py-1 text-xs text-neutral-400">No groups yet</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
