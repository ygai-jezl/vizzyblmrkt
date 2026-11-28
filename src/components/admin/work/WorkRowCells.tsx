import Link from "next/link";
import type { Ref } from "react";
import { CalendarClock, ChevronRight, GitPullRequest, Lightbulb, Sparkles } from "lucide-react";
import { Chip } from "@/components/admin/people/Chip";
import type { WorkRow } from "@/lib/work/list";
import { ideaWord } from "@/lib/nav/terms";
import { WORK_COPY } from "@/lib/work/screenWords";

/**
 * A row of Work's list as its cells: the ref, title, status, stage, brand (when the person sees
 * more than one), the idea, what it waits for and its check. The list (WorkTable.tsx) and the list
 * with quick edit (WorkQuickTable.tsx, WORK_QUICK_EDIT_ENABLED) draw the same cells; with `quick`
 * the ref is a button that opens and closes the row, and each cell says which field it is, so a
 * click on it opens the row there. Without `quick` they are the list's cells as they always were.
 */

/** The columns: the Task column may shrink to 10rem with quick edit, so Check fits beside it. */
export function rowCols(multiBrand: boolean, quick = false): string {
  // Written out whole, so Tailwind finds each class in the source.
  if (quick) return multiBrand ? "grid-cols-[4rem_minmax(10rem,1fr)_7rem_8rem_9rem_8rem_8rem_10rem]" : "grid-cols-[4rem_minmax(10rem,1fr)_7rem_8rem_8rem_8rem_10rem]";
  return multiBrand ? "grid-cols-[4rem_minmax(14rem,1fr)_7rem_8rem_9rem_8rem_8rem_10rem]" : "grid-cols-[4rem_minmax(14rem,1fr)_7rem_8rem_8rem_8rem_10rem]";
}

/** The column heads, in the cells' order. */
export function rowHeads(multiBrand: boolean, ideaWords: boolean): string[] {
  return ["Ref", "Task", "Status", "Stage", ...(multiBrand ? ["Brand"] : []), ideaWord(ideaWords).One, "Blocked by", "Check"];
}

/** What a row needs with quick edit: whether it is open, the open row's id, and its Ref button. */
export interface QuickCells {
  open: boolean;
  panelId: string;
  refButton?: Ref<HTMLButtonElement>;
}

export function WorkRowCells({ row: r, multiBrand, ideaWords, quick }: { row: WorkRow; multiBrand: boolean; ideaWords: boolean; quick?: QuickCells }) {
  const nowIdea = ideaWords ? "Now an idea" : "Now a launch";
  // Which field a cell opens the row on; nothing without quick edit, so the list draws as before.
  const cell = (k: string) => (quick ? k : undefined);
  const chip = (k: string, el: JSX.Element) =>
    quick ? (
      <span data-cell={k} className="inline-flex">
        {el}
      </span>
    ) : (
      el
    );
  return (
    <>
      {quick ? (
        <span role="cell" data-cell="ref">
          <button
            ref={quick.refButton}
            type="button"
            aria-expanded={quick.open}
            aria-controls={quick.open ? quick.panelId : undefined}
            data-ref-button={r.ref}
            className="inline-flex items-center gap-0.5 rounded px-1 tabular-nums text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <ChevronRight size={12} aria-hidden className={`shrink-0 transition-transform ${quick.open ? "rotate-90" : ""}`} />#{r.ref}
          </button>
        </span>
      ) : (
        <span role="cell" className="tabular-nums text-neutral-500 dark:text-neutral-400">
          #{r.ref}
        </span>
      )}
      <span role="cell" className="min-w-0 space-y-1" data-cell={cell("title")}>
        <span className="flex flex-wrap items-center gap-1.5">
          <Link href={r.href} className="font-medium text-neutral-900 hover:underline dark:text-neutral-100" data-title-link={quick ? r.ref : undefined}>
            {r.title}
          </Link>
          {r.mustHave ? chip("must", <Chip tone="violet">Must have</Chip>) : null}
          {r.fromVizzy
            ? chip(
                "vizzy",
                <Chip tone="blue">
                  <Sparkles size={10} aria-hidden className="mr-0.5 inline" />
                  From Vizzy
                </Chip>,
              )
            : null}
          {r.prs.map((pr) =>
            quick ? (
              <span key={pr} data-cell="pr" className="inline-flex">
                <Chip>
                  <GitPullRequest size={10} aria-hidden className="mr-0.5 inline" />
                  <span className="sr-only">Pull request </span>
                  {pr}
                </Chip>
              </span>
            ) : (
              <Chip key={pr}>
                <GitPullRequest size={10} aria-hidden className="mr-0.5 inline" />
                <span className="sr-only">Pull request </span>
                {pr}
              </Chip>
            ),
          )}
        </span>
      </span>
      <span role="cell" data-cell={cell("status")}>
        <Chip tone={r.tone}>{r.statusLabel}</Chip>
      </span>
      <span role="cell" className="text-neutral-600 dark:text-neutral-300" data-cell={cell("stage")}>
        {r.stage ? (
          <>
            <span aria-hidden className="mr-1 tabular-nums text-neutral-400">
              {r.stage.n}
            </span>
            {r.stage.label}
          </>
        ) : null}
      </span>
      {multiBrand ? (
        <span role="cell" className={r.brand ? "text-neutral-600 dark:text-neutral-300" : "text-neutral-400"} data-cell={cell("brand")}>
          {r.brand ?? "Whole business"}
        </span>
      ) : null}
      <span role="cell" className="flex min-w-0 flex-col gap-1" data-cell={cell("idea")}>
        {r.madeIdea ? <Chip tone="violet">{nowIdea}</Chip> : null}
        {r.ideas.map((name, i) => (
          <span key={`${name}${i}`} className="inline-flex min-w-0 items-center gap-1 text-neutral-600 dark:text-neutral-300">
            <Lightbulb size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{name}</span>
          </span>
        ))}
      </span>
      <span role="cell" data-cell={cell("block")}>
        {r.waitingOn ? (
          <Link
            href={`/admin/work/${r.waitingOn.ref}`}
            title={`#${r.waitingOn.ref} ${r.waitingOn.title} isn't done yet`}
            className="text-amber-700 hover:underline dark:text-amber-300"
            data-wait={quick ? r.waitingOn.ref : undefined}
          >
            Waiting on #{r.waitingOn.ref}
          </Link>
        ) : null}
      </span>
      <span role="cell" className="space-y-1" data-cell={cell("check")}>
        {r.check ? (
          <span
            className={`inline-flex items-center gap-1 ${
              r.check.due ? "font-medium text-amber-700 dark:text-amber-300" : r.check.forecast ? "text-neutral-400" : "text-neutral-600 dark:text-neutral-300"
            }`}
          >
            <CalendarClock size={12} aria-hidden className="shrink-0" />
            {r.check.forecast ? `Asks ${r.check.label}` : r.check.label}
          </span>
        ) : null}
        {r.win ? (
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">
            <span className="sr-only">{WORK_COPY.howWellKnow} </span>
            {r.win}
          </span>
        ) : null}
      </span>
    </>
  );
}
