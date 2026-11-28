import type { WorkRow } from "@/lib/work/list";
import { rowCols, rowHeads, WorkRowCells } from "./WorkRowCells";

/**
 * Work's one list: a row per task, with its ref, title, status, stage, brand (when the person sees
 * more than one), the idea, what it waits for and its check. Checks due come first; the service
 * sorts. Titles are the team's own words. The cells are WorkRowCells, shared with the list's quick
 * edit (WorkQuickTable.tsx).
 */
export function WorkTable({ rows, multiBrand, ideaWords }: { rows: WorkRow[]; multiBrand: boolean; ideaWords: boolean }) {
  const cols = rowCols(multiBrand);
  const head = rowHeads(multiBrand, ideaWords);
  return (
    <div role="table" aria-label="Tasks" className="overflow-x-auto rounded-md border border-neutral-200 text-sm dark:border-neutral-800">
      <div role="row" className={`grid ${cols} gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400`}>
        {head.map((h) => (
          <span key={h} role="columnheader">
            {h}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div
          key={r.id}
          role="row"
          className={`grid ${cols} items-start gap-3 border-b border-neutral-100 px-3 py-2.5 last:border-b-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/50 ${r.closed ? "text-neutral-500 dark:text-neutral-400" : ""}`}
        >
          <WorkRowCells row={r} multiBrand={multiBrand} ideaWords={ideaWords} />
        </div>
      ))}
    </div>
  );
}
