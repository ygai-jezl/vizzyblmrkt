import Link from "next/link";
import { CalendarClock, GitPullRequest, Lightbulb, Sparkles } from "lucide-react";
import { Chip } from "@/components/admin/people/Chip";
import type { WorkRow } from "@/lib/work/list";
import { ideaWord } from "@/lib/nav/terms";
import { WORK_COPY } from "@/lib/work/screenWords";

/**
 * Work's one list: a row per task, with its ref, title, status, stage, brand (when the person sees
 * more than one), the idea, what it waits for and its check. Checks due come first; the service
 * sorts. Titles are the team's own words.
 */
export function WorkTable({ rows, multiBrand, ideaWords }: { rows: WorkRow[]; multiBrand: boolean; ideaWords: boolean }) {
  const cols = multiBrand ? "grid-cols-[4rem_minmax(14rem,1fr)_7rem_8rem_9rem_8rem_8rem_10rem]" : "grid-cols-[4rem_minmax(14rem,1fr)_7rem_8rem_8rem_8rem_10rem]";
  const head = ["Ref", "Task", "Status", "Stage", ...(multiBrand ? ["Brand"] : []), ideaWord(ideaWords).One, "Blocked by", "Check"];
  const nowIdea = ideaWords ? "Now an idea" : "Now a launch";
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
          <span role="cell" className="tabular-nums text-neutral-500 dark:text-neutral-400">
            #{r.ref}
          </span>
          <span role="cell" className="min-w-0 space-y-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Link href={r.href} className="font-medium text-neutral-900 hover:underline dark:text-neutral-100">
                {r.title}
              </Link>
              {r.mustHave ? <Chip tone="violet">Must have</Chip> : null}
              {r.fromVizzy ? (
                <Chip tone="blue">
                  <Sparkles size={10} aria-hidden className="mr-0.5 inline" />
                  From Vizzy
                </Chip>
              ) : null}
              {r.prs.map((pr) => (
                <Chip key={pr}>
                  <GitPullRequest size={10} aria-hidden className="mr-0.5 inline" />
                  <span className="sr-only">Pull request </span>
                  {pr}
                </Chip>
              ))}
            </span>
          </span>
          <span role="cell">
            <Chip tone={r.tone}>{r.statusLabel}</Chip>
          </span>
          <span role="cell" className="text-neutral-600 dark:text-neutral-300">
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
            <span role="cell" className={r.brand ? "text-neutral-600 dark:text-neutral-300" : "text-neutral-400"}>
              {r.brand ?? "Whole business"}
            </span>
          ) : null}
          <span role="cell" className="flex min-w-0 flex-col gap-1">
            {r.madeIdea ? <Chip tone="violet">{nowIdea}</Chip> : null}
            {r.ideas.map((name, i) => (
              <span key={`${name}${i}`} className="inline-flex min-w-0 items-center gap-1 text-neutral-600 dark:text-neutral-300">
                <Lightbulb size={12} aria-hidden className="shrink-0" />
                <span className="truncate">{name}</span>
              </span>
            ))}
          </span>
          <span role="cell">
            {r.waitingOn ? (
              <Link href={`/admin/work/${r.waitingOn.ref}`} title={`#${r.waitingOn.ref} ${r.waitingOn.title} isn't done yet`} className="text-amber-700 hover:underline dark:text-amber-300">
                Waiting on #{r.waitingOn.ref}
              </Link>
            ) : null}
          </span>
          <span role="cell" className="space-y-1">
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
        </div>
      ))}
    </div>
  );
}
