"use client";

import { useState } from "react";
import { ArrowDownUp, Columns3, Lock } from "lucide-react";
import { columnKind, isSortable } from "@/lib/views/conditions";
import { BUILT_IN_COLUMNS, VIEW_LIMITS, type ViewSort } from "@/lib/views/types";
import { columnName, sortDirWords, sortInWords, type ViewNames } from "@/lib/views/words";
import { MenuHeading, Popover } from "./ViewMenu";

/**
 * Columns, up to 10 with Person always first, and Sort, by any column with an order (CRM_VIEWS_ENABLED).
 * A new column goes last. Changing columns reads the rows shown again; changing the sort runs the
 * view again.
 */

/** Every column the brand's view can show: the list's own, then each People field in use. */
export function columnChoices(names: ViewNames): string[] {
  return [...BUILT_IN_COLUMNS, ...names.fields.filter((f) => f.object === "person" && !f.archivedAt).map((f) => f.key)];
}

export function ColumnPicker({ columns, names, onChange }: { columns: string[]; names: ViewNames; onChange: (columns: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const full = columns.length >= VIEW_LIMITS.columns;
  return (
    <Popover label="Columns" icon={<Columns3 size={14} aria-hidden />} open={open} setOpen={setOpen} align="right">
      <MenuHeading>Columns, up to {VIEW_LIMITS.columns}</MenuHeading>
      {columnChoices(names).map((id) => {
        const on = columns.includes(id);
        const locked = id === "person";
        return (
          <label key={id} className={`flex items-center gap-2 rounded px-2 py-1.5 ${locked || (!on && full) ? "opacity-70" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}>
            <input
              type="checkbox"
              checked={on}
              disabled={locked || (!on && full)}
              onChange={() => onChange(on ? columns.filter((c) => c !== id) : [...columns, id])}
            />
            <span className="flex-1">{columnName(id, names)}</span>
            {locked ? <Lock size={12} aria-label="Always shown" className="text-neutral-400" /> : null}
          </label>
        );
      })}
    </Popover>
  );
}

export function SortMenu({ sort, columns, names, onChange }: { sort: ViewSort | null; columns: string[]; names: ViewNames; onChange: (sort: ViewSort | null) => void }) {
  const [open, setOpen] = useState(false);
  // The columns shown first, then any other with an order.
  const sortable = [...new Set([...columns, ...columnChoices(names)])].filter((id) => isSortable(columnKind(id, names.fields)));
  const choose = (s: ViewSort | null) => {
    setOpen(false);
    onChange(s);
  };
  const btn = (active: boolean) =>
    `rounded px-1.5 py-0.5 text-xs ${active ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"}`;
  return (
    <Popover label={`Sort: ${sortInWords(sort, names)}`} icon={<ArrowDownUp size={14} aria-hidden />} open={open} setOpen={setOpen} align="right">
      <button type="button" role="menuitem" onClick={() => choose(null)} className={`w-full rounded px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900 ${sort ? "" : "font-medium"}`}>
        Most recently active first
      </button>
      {sortable.map((id) => (
        <div key={id} className="flex items-center gap-2 rounded px-2 py-1.5">
          <span className="flex-1">{columnName(id, names)}</span>
          {(["desc", "asc"] as const).map((dir) => (
            <button key={dir} type="button" className={btn(sort?.by === id && sort.dir === dir)} onClick={() => choose({ by: id, dir })}>
              {sortDirWords(id, dir, names.fields)}
            </button>
          ))}
        </div>
      ))}
    </Popover>
  );
}
