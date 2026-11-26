"use client";

import { useState } from "react";
import { ArrowDownUp, ChevronDown, ChevronUp, Columns3, GripVertical, Lock } from "lucide-react";
import { columnKind, isSortable } from "@/lib/views/conditions";
import { BUILT_IN_COLUMNS, VIEW_LIMITS, type ViewSort } from "@/lib/views/types";
import { columnName, sortDirWords, sortInWords, type ViewNames } from "@/lib/views/words";
import { MenuHeading, Popover } from "./ViewMenu";

/**
 * Columns, up to 10 with Person always first, and Sort, by any column with an order (CRM_VIEWS_ENABLED).
 * The chosen columns come first, in their order: drag one, or use its up and down buttons, to move
 * it. A new column goes last. A column on an archived field is marked and can be taken out, so it
 * never holds one of the 10 for good. Changing columns reads the rows shown again; changing the
 * sort runs the view again.
 */

/** Every column the brand's view can show: the list's own, then each People field in use. */
export function columnChoices(names: ViewNames): string[] {
  return [...BUILT_IN_COLUMNS, ...names.fields.filter((f) => f.object === "person" && !f.archivedAt).map((f) => f.key)];
}

/** The columns with one moved to another place; Person stays first. Pure. */
export function moveColumn(columns: readonly string[], from: number, to: number): string[] {
  if (from < 1 || to < 1 || from >= columns.length || to >= columns.length || from === to) return [...columns];
  const next = [...columns];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

const iconButton = "rounded p-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-200";

/** The picker's list: the chosen columns in order, then the rest. */
export function ColumnList({ columns, names, onChange }: { columns: string[]; names: ViewNames; onChange: (columns: string[]) => void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const full = columns.length >= VIEW_LIMITS.columns;
  const others = columnChoices(names).filter((id) => !columns.includes(id));
  return (
    <>
      <MenuHeading>Columns, up to {VIEW_LIMITS.columns}</MenuHeading>
      {columns.map((id, i) => {
        const locked = id === "person";
        const name = columnName(id, names);
        const archived = columnKind(id, names.fields) === null;
        return (
          <div
            key={id}
            draggable={!locked}
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (dragging !== null && !locked) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging !== null) onChange(moveColumn(columns, dragging, i));
              setDragging(null);
            }}
            onDragEnd={() => setDragging(null)}
            className={`flex items-center gap-2 rounded px-2 py-1.5 ${locked ? "opacity-70" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"} ${dragging === i ? "opacity-50" : ""}`}
          >
            <label className="flex flex-1 items-center gap-2">
              <input type="checkbox" checked disabled={locked} onChange={() => onChange(columns.filter((c) => c !== id))} />
              <span className={archived ? "text-neutral-500 line-through" : ""}>{name}</span>
              {archived ? <span className="text-xs text-amber-700 dark:text-amber-400">Archived</span> : null}
            </label>
            {locked ? (
              <Lock size={12} aria-label="Always shown" className="text-neutral-400" />
            ) : (
              <span className="flex items-center gap-0.5">
                <button type="button" className={iconButton} aria-label={`Move ${name} up`} disabled={i <= 1} onClick={() => onChange(moveColumn(columns, i, i - 1))}>
                  <ChevronUp size={12} aria-hidden />
                </button>
                <button type="button" className={iconButton} aria-label={`Move ${name} down`} disabled={i >= columns.length - 1} onClick={() => onChange(moveColumn(columns, i, i + 1))}>
                  <ChevronDown size={12} aria-hidden />
                </button>
                <GripVertical size={14} aria-hidden className="cursor-grab text-neutral-400" />
              </span>
            )}
          </div>
        );
      })}
      {others.map((id) => (
        <label key={id} className={`flex items-center gap-2 rounded px-2 py-1.5 ${full ? "opacity-70" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}>
          <input type="checkbox" checked={false} disabled={full} onChange={() => onChange([...columns, id])} />
          <span className="flex-1">{columnName(id, names)}</span>
        </label>
      ))}
    </>
  );
}

export function ColumnPicker({ columns, names, onChange }: { columns: string[]; names: ViewNames; onChange: (columns: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover label="Columns" icon={<Columns3 size={14} aria-hidden />} open={open} setOpen={setOpen} align="right">
      <ColumnList columns={columns} names={names} onChange={onChange} />
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
