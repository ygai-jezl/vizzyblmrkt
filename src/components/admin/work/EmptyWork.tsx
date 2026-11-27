import Link from "next/link";
import { FileUp, ListPlus, Sparkles } from "lucide-react";
import { COMPANY_STAGES } from "@/lib/work/stages";
import { emptyText, emptyTitle, IMPORT_COLUMNS, WORK_COPY } from "@/lib/work/screenWords";
import { ImportButton } from "./ImportDialog";
import { AskVizzyForTasks } from "./QuickAdd";

/**
 * Work's first visit: the ten stages of the Path, then three ways to start: import the backlog
 * (admins and owners), add the first task, or, with Vizzy's Work tools on, ask Vizzy for a start.
 */
export function EmptyWork({ name, multiBrand, canImport, workVizzy, brands, wholeBusiness }: { name: string; multiBrand: boolean; canImport: boolean; workVizzy: boolean; brands: Array<{ id: string; name: string }>; wholeBusiness: boolean }) {
  return (
    <section aria-labelledby="wk-empty-h" className="space-y-5 rounded-lg border border-dashed border-neutral-300 p-6 dark:border-neutral-700">
      <div role="list" aria-label="The 10 stages" className="flex flex-wrap gap-1.5">
        {COMPANY_STAGES.map((s) => (
          <div key={s.id} role="listitem" className="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
            <span className="tabular-nums text-neutral-400">{s.n}</span>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <h2 id="wk-empty-h" className="text-lg font-semibold">
          {emptyTitle(name)}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{emptyText(multiBrand)}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {canImport ? (
          <div className="space-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            <p className="flex items-center gap-1.5 font-medium">
              <FileUp size={16} aria-hidden />
              {WORK_COPY.importTitle}
            </p>
            <p className="text-neutral-600 dark:text-neutral-400">{WORK_COPY.importText}</p>
            <span className="flex flex-wrap gap-1">
              {IMPORT_COLUMNS.map((c) => (
                <span key={c} className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
                  {c}
                </span>
              ))}
            </span>
            <span className="flex flex-wrap gap-2 pt-1">
              <ImportButton label="Choose a CSV" start="csv" brands={brands} wholeBusiness={wholeBusiness} />
              <ImportButton label="Paste rows" start="paste" brands={brands} wholeBusiness={wholeBusiness} />
            </span>
          </div>
        ) : null}
        <div className="space-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <p className="flex items-center gap-1.5 font-medium">
            <ListPlus size={16} aria-hidden />
            {WORK_COPY.firstTaskTitle}
          </p>
          <p className="text-neutral-600 dark:text-neutral-400">{WORK_COPY.firstTaskText}</p>
          <Link href="/admin/work/new" className="inline-flex rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900">
            Add task
          </Link>
        </div>
        {workVizzy ? (
          <div className="space-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            <p className="flex items-center gap-1.5 font-medium">
              <Sparkles size={16} aria-hidden />
              {WORK_COPY.vizzyStartTitle}
            </p>
            <p className="text-neutral-600 dark:text-neutral-400">{WORK_COPY.vizzyStartText}</p>
            <AskVizzyForTasks />
          </div>
        ) : null}
      </div>
    </section>
  );
}
