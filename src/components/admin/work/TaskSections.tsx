"use client";

import { Fragment, useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { CalendarClock, Clock, FileText, Lightbulb, Link2, Sparkles, Upload } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { Chip, chipToneClass } from "@/components/admin/people/Chip";
import { ideaWord } from "@/lib/nav/terms";
import { blankCheck, checkInputOf, freeLinkWords, typedLinkHref, typedLinkWords, type CheckDraft } from "@/lib/work/form";
import type { CheckInput, MeasureInput } from "@/lib/work/inputs";
import { afterTaskDueLine, changeWords, checkSideLine, historyNewest, initialsOf, noLinksText, originParts, whenWords, whoInline, whoWords, WORK_COPY, WORK_STATUS_TONE } from "@/lib/work/screenWords";
import { COMPANY_STAGES, type CompanyStage } from "@/lib/work/stages";
import { SET_BY_MEASURE, WORK_STATUSES, type TypedLink, type WorkLink, type WorkRecent, type WorkStatus, type WorkTask } from "@/lib/work/types";
import { dayOf, PLAN_STATE_LABEL, WORK_STATUS_LABEL } from "@/lib/work/words";
import type { TaskScreen } from "@/lib/work/screens";
import type { WorkTaskPage } from "@/lib/work/service";
import { CheckActions, MoveCheck, type CheckAnswer, type CheckSend } from "./CheckActions";
import { ApprovePlan } from "./Decisions";
import { MeasureSection } from "./MeasureSection";
import { useFocusMark, useRowEditor } from "./rowEditors";
import { BlockedByPicker, CheckPicker, FreeLinksEditor, TypedLinksEditor } from "./TaskFields";
import { useFocusSwap } from "./useFocusSwap";

/**
 * A task's sections (ADR-0020), each drawing a given task and calling a given save: the task page
 * (/admin/work/[ref]) lays them out as it always has, and the open row on Work's list
 * (WORK_QUICK_EDIT_ENABLED) lays out the same sections under the row. The page passes its own
 * task and its one change at a time; the row passes the task with what the person just picked,
 * and its line of changes. Markup is the page's own: src/components/admin/work/taskPageLock.test.ts
 * holds it to what it was before the split.
 */

export const SIDE_LABEL = "text-xs font-medium text-neutral-500 dark:text-neutral-400";

/** What the sections say back to a save: true once it saved. */
export type Save<T> = (value: T) => Promise<boolean>;

/** A link to another task, opened in place by the row; the page leaves the click alone. */
export type OnGoto = (e: MouseEvent<HTMLAnchorElement>, ref: number) => void;

/** What every section works out from the screen, the task as shown and its page. */
export function taskBits(screen: TaskScreen, task: WorkTask, page: WorkTaskPage) {
  const { options } = screen;
  const brandName = (id: string) => [...options.brands, ...screen.brandChoices].find((b) => b.id === id)?.name;
  const ideaName = (b: string, i: string) => screen.ideaNames[`${b}:${i}`] ?? options.ideas.find((x) => x.value === `${b}:${i}`)?.label;
  const byMeasure = task.check?.setBy === SET_BY_MEASURE;
  const repos = screen.measureBrand ? (options.brands.find((b) => b.id === screen.measureBrand!.id)?.repos ?? []) : options.brands.flatMap((b) => b.repos);
  const waitingOn = page.waiting ? page.blockers.find((b): b is Extract<typeof b, { ref: number }> => "ref" in b && b.status !== "done" && b.status !== "dropped") : undefined;
  return {
    brandName,
    ideaName,
    word: ideaWord(screen.ideaWords),
    byMeasure,
    repos,
    lastMove: task.recent.find((r) => r.field === "status"),
    open: task.status !== "done" && task.status !== "dropped",
    waitingOn,
  };
}

/** Text where `backticked` commands render as code, each with a Copy button. */
export function DescriptionText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]{1,200}`)/g);
  return (
    <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <span key={i} className="inline-flex items-center gap-1 rounded border border-neutral-200 bg-neutral-50 px-1 dark:border-neutral-800 dark:bg-neutral-900">
            <code className="font-mono text-[0.85em]">{p.slice(1, -1)}</code>
            <CopyButton value={p.slice(1, -1)} />
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </p>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-[11px] text-neutral-500 underline underline-offset-2"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** One line of History: who, what, when. The newest "added" says where the task came from. */
export function historyLine(
  r: WorkRecent,
  o: { me: string; names: Readonly<Record<string, string>>; origin: WorkTask["origin"]; brandName: (id: string) => string | undefined; timeZone: string; today: string; ideaWords?: boolean },
): { who: string; what: string; when: string; vizzy: boolean } {
  const who = whoWords(r.who, o.me, o.names);
  let what = changeWords(r.field, r.before, r.after, { brandName: o.brandName, ideaWords: o.ideaWords });
  if (r.field === "added" && o.origin.kind === "import") what = `imported it from ${o.origin.file ?? "a sheet"}`;
  if (r.field === "added" && o.origin.kind === "suggestion") what = "added it from Vizzy's suggestion";
  return { who, what, when: whenWords(r.at, o.timeZone, o.today), vizzy: r.who.kind === "vizzy" };
}

/** The chips beside the title: what it waits for, the idea it became, Must have. */
export function TaskChips({ task, waitingOn, ideaWords }: { task: WorkTask; waitingOn: { ref: number } | undefined; ideaWords: boolean }) {
  return (
    <>
      {waitingOn ? <Chip tone="amber">Waiting on #{waitingOn.ref}</Chip> : null}
      {task.ideaId ? <Chip tone="violet">{ideaWords ? "Now an idea" : "Now a launch"}</Chip> : null}
      {task.mustHave ? <Chip tone="violet">Must have</Chip> : null}
    </>
  );
}

/** Where the task came from, with who added it. */
export function OriginLine({ screen, task, page }: { screen: TaskScreen; task: WorkTask; page: WorkTaskPage }) {
  const { me } = screen;
  const origin = originParts(task.origin, task.createdAt, page.timeZone, me, page.names, screen.suggested ? { from: screen.suggested.from, edited: screen.suggested.edited.length > 0 } : null);
  return (
    <p className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
      <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-neutral-100 text-[10px] font-semibold dark:bg-neutral-800">
        {task.origin.kind === "suggestion" ? <Sparkles size={12} /> : task.origin.kind === "import" ? <Upload size={12} /> : initialsOf(whoWords({ kind: "person", id: "by" in task.origin ? task.origin.by : null }, me, page.names))}
      </span>
      <span>
        <span className="font-medium">{origin.from}</span> {origin.rest}
      </span>
    </p>
  );
}

/** On a task added from Vizzy's suggestion: what Vizzy wrote for each field the person changed. */
export function VizzySuggested({ screen }: { screen: TaskScreen }) {
  const mark = useFocusMark();
  if (!screen.suggested?.edited.length) return null;
  return (
    <details className="text-sm text-neutral-600 dark:text-neutral-300" data-qe={mark("vizzy-box")}>
      <summary className="cursor-pointer font-medium" data-qe={mark("vizzy")}>
        {WORK_COPY.vizzySuggested}
      </summary>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.vizzySuggestedHint}</p>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {screen.suggested.edited.map((e) => (
          <div key={e.label} className="contents">
            <dt className="text-neutral-500 dark:text-neutral-400">{e.label}</dt>
            <dd className="break-words">{e.was}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** A region that didn't answer, so a task this one names may be missing. */
export function RegionsDownNote({ page }: { page: WorkTaskPage }) {
  return page.regionsDown.length ? (
    <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      {WORK_COPY.taskRegionsDown}
    </p>
  ) : null;
}

/** A due check: what it asks, and its buttons. The row passes its line of changes as the sender. */
export function DueCheckBanner({
  screen,
  task,
  page,
  via,
  send,
  onStart,
  onSaid,
}: {
  screen: TaskScreen;
  task: WorkTask;
  page: WorkTaskPage;
  via: "work_page" | "work_list";
  send?: (body: CheckSend) => Promise<CheckAnswer>;
  onStart: () => void;
  onSaid: (notice: string) => void;
}) {
  if (!page.due || !task.check) return null;
  const byMeasure = task.check.setBy === SET_BY_MEASURE;
  return (
    <div role="status" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
      <p className="flex items-start gap-1.5">
        <CalendarClock size={16} aria-hidden className="mt-0.5 shrink-0" />
        {byMeasure ? (
          <span>
            <strong>{WORK_COPY.measureDueTitle}</strong> {screen.checkPartLine} {page.checkLine}
          </span>
        ) : (
          <span>
            <strong>{WORK_COPY.checkDue}</strong> {task.check.note || (task.check.kind === "after_task" && screen.afterRef ? afterTaskDueLine(screen.afterRef) : WORK_COPY.checkDueText)}
          </span>
        )}
      </p>
      <CheckActions taskRef={task.ref} byMeasure={byMeasure} via={via} setAt={task.check.setAt} onStart={onStart} onSaid={onSaid} send={send} />
    </div>
  );
}

/** What the task waits for, while it is open. */
export function WaitingBanner({ waitingOn, open, onGoto }: { waitingOn: { ref: number; title: string } | undefined; open: boolean; onGoto?: OnGoto }) {
  if (!waitingOn || !open) return null;
  return (
    <p role="status" className="flex items-start gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <Clock size={16} aria-hidden className="mt-0.5 shrink-0" />
      <span>
        <strong>
          Waiting on{" "}
          <Link href={`/admin/work/${waitingOn.ref}`} className="underline underline-offset-4" onClick={onGoto ? (e) => onGoto(e, waitingOn.ref) : undefined}>
            #{waitingOn.ref} {waitingOn.title}
          </Link>
          .
        </strong>{" "}
        {WORK_COPY.blockedText}
      </span>
    </p>
  );
}

/** Status: To do, In progress, Waiting, Done or Dropped, with who moved it last. */
export function StatusField({ screen, page, status, lastMove, disabled, onPick }: { screen: TaskScreen; page: WorkTaskPage; status: WorkStatus; lastMove: WorkRecent | undefined; disabled: boolean; onPick: (s: WorkStatus) => void }) {
  const mark = useFocusMark();
  return (
    <div className="space-y-1">
      <p id="wk-status-l" className={SIDE_LABEL}>
        Status
      </p>
      <div role="radiogroup" aria-labelledby="wk-status-l" className="flex flex-wrap gap-1.5">
        {WORK_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={status === s}
            disabled={disabled}
            data-qe={mark(status === s ? "status" : `status-${s}`)}
            onClick={() => (status === s ? null : onPick(s))}
            className={`rounded-md border px-2.5 py-1 text-sm ${status === s ? `border-neutral-900 font-medium dark:border-white ${chipToneClass(WORK_STATUS_TONE[s])}` : "border-neutral-300 dark:border-neutral-700"}`}
          >
            {WORK_STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {lastMove ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Last moved by {whoInline(lastMove.who, screen.me, page.names)} on {dayOf(lastMove.at, page.timeZone)}.
        </p>
      ) : null}
    </div>
  );
}

/** Connected to and Other links, with Add a link opening both editors in place. */
export function LinksSection({
  screen,
  task,
  page,
  onTyped,
  onFree,
}: {
  screen: TaskScreen;
  task: WorkTask;
  page: WorkTaskPage;
  onTyped: (links: TypedLink[]) => void;
  onFree: (links: WorkLink[]) => void;
}) {
  const { options, me } = screen;
  const tz = page.timeZone;
  const { ideaName, repos } = taskBits(screen, task, page);
  const mark = useFocusMark();
  const [linking, setLinking] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [typedDirty, setTypedDirty] = useState(false);
  const [freeDirty, setFreeDirty] = useState(false);
  useRowEditor("links", linking ? { label: WORK_COPY.rowLinksLabel, dirty: typedDirty || freeDirty, close: () => setLinking(false) } : null);
  const plans = new Map(page.plans.map((p) => [`${p.url}@${p.version ?? ""}`, p]));
  const decisionBy = (id: string | null) => page.decisions.find((d) => d.id === id);
  return (
    <section aria-labelledby="wk-links-h" className="space-y-3" data-qe={mark("links")} tabIndex={mark("links") ? -1 : undefined}>
      <div className="flex items-center justify-between gap-2">
        <h2 id="wk-links-h" className="text-sm font-semibold">
          Links
        </h2>
        <Button onClick={() => setLinking(!linking)}>{linking ? "Done" : "Add a link"}</Button>
      </div>
      {linking ? (
        <div className="space-y-4 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <div className="space-y-1">
            <p className={SIDE_LABEL}>Connected to</p>
            <TypedLinksEditor
              links={task.typedLinks}
              onChange={onTyped}
              repos={repos}
              ideas={options.ideas}
              operator={options.operator}
              loopsRepo={options.loopsRepo}
              ideaName={ideaName}
              ideaWords={screen.ideaWords}
              onDirty={setTypedDirty}
            />
          </div>
          <div className="space-y-1">
            <p className={SIDE_LABEL}>Other links</p>
            <FreeLinksEditor links={task.links} onChange={onFree} hasRepo={repos.length > 0} onDirty={setFreeDirty} />
          </div>
        </div>
      ) : task.typedLinks.length || task.links.length ? (
        <>
          {task.typedLinks.length ? (
            <div className="space-y-1.5">
              <p className={SIDE_LABEL}>Connected to</p>
              <ul className="space-y-1.5">
                {task.typedLinks.map((l, i) => (
                  <TypedLinkRow
                    key={`${l.kind}${i}`}
                    link={l}
                    words={typedLinkWords(l, { ideaName, ideaWords: screen.ideaWords })}
                    href={typedLinkHref(l, screen.sessionBrand.id)}
                    plan={l.kind === "plan" ? plans.get(`${l.url}@${l.version ?? ""}`) : undefined}
                    planBy={(id) => {
                      const d = decisionBy(id);
                      return d?.decision.chosen ? `${whoInline({ kind: "person", id: d.decision.chosen.by }, me, page.names)} on ${dayOf(d.at, tz)}` : null;
                    }}
                    approving={approving === `${i}`}
                    onApprove={() => setApproving(`${i}`)}
                    onCloseApprove={() => setApproving(null)}
                    taskRef={task.ref}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {task.links.length ? (
            <div className="space-y-1.5">
              <p className={SIDE_LABEL}>Other links</p>
              <ul className="space-y-1.5">
                {task.links.map((l, i) => {
                  const w = freeLinkWords(l);
                  return (
                    <li key={`${l.url}${i}`}>
                      <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-2 rounded-md border border-neutral-200 px-2 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900">
                        <Link2 size={14} aria-hidden className="shrink-0 text-neutral-500" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{w.label}</span>
                          <span className="block text-xs text-neutral-500">{w.where}</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{noLinksText(repos.length > 0, screen.ideaWords)}</p>
      )}
    </section>
  );
}

/** A Connected to row: a link that opens, or a plan with its approval and Approve the plan. */
function TypedLinkRow({
  link,
  words,
  href,
  plan,
  planBy,
  approving,
  onApprove,
  onCloseApprove,
  taskRef,
}: {
  link: TypedLink;
  words: { label: string; where: string };
  href: string | null;
  plan?: { url: string; version: string | null; state: keyof typeof PLAN_STATE_LABEL; decisionId: string | null };
  planBy: (decisionId: string | null) => string | null;
  approving: boolean;
  onApprove: () => void;
  onCloseApprove: () => void;
  taskRef: number;
}) {
  const body = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {link.kind === "plan" ? <FileText size={14} aria-hidden className="shrink-0 text-neutral-500" /> : <Link2 size={14} aria-hidden className="shrink-0 text-neutral-500" />}
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${link.kind === "switch" || link.kind === "loop_line" ? "font-mono text-xs" : "font-medium"}`}>{words.label}</span>
        <span className="block text-xs text-neutral-500">{words.where}</span>
      </span>
    </span>
  );
  const external = href !== null && href.startsWith("https://");
  const by = plan?.state === "approved" ? planBy(plan.decisionId) : null;
  // Approve the plan opens its choices in its place: focus moves into them, and back on Cancel.
  const focus = useFocusSwap(approving);
  return (
    <li className="rounded-md border border-neutral-200 px-2 py-1.5 text-sm dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        {href ? (
          <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})} className="flex min-w-0 flex-1 hover:underline">
            {body}
          </a>
        ) : (
          body
        )}
        {plan ? <Chip tone={plan.state === "approved" ? "green" : plan.state === "change_it" ? "amber" : "neutral"}>{by ? `Approved by ${by}` : PLAN_STATE_LABEL[plan.state]}</Chip> : null}
        {plan && plan.state !== "approved" && !approving ? (
          <span ref={focus.opener}>
            <Button aria-expanded={false} aria-controls="wk-approve" onClick={onApprove}>
              Approve the plan
            </Button>
          </span>
        ) : null}
      </div>
      {plan && approving ? (
        <div ref={focus.form}>
          <ApprovePlan taskRef={taskRef} url={plan.url} version={plan.version} onClose={onCloseApprove} />
        </div>
      ) : null}
    </li>
  );
}

/** History: who changed what, newest first. The row shows the newest `limit`, with Show all. */
export function HistorySection({ screen, task, page, limit }: { screen: TaskScreen; task: WorkTask; page: WorkTaskPage; limit?: number }) {
  const { brandName } = taskBits(screen, task, page);
  const [all, setAll] = useState(false);
  const rows = task.recent.filter((r) => r.field !== "ideaBrandId");
  const cut = limit !== undefined && !all && rows.length > limit;
  const shown = cut ? rows.slice(0, limit) : rows;
  return (
    <section aria-labelledby="wk-hist-h" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="wk-hist-h" className="text-sm font-semibold">
          History
        </h2>
        <span className="text-xs text-neutral-500">{cut ? historyNewest(limit!, rows.length) : WORK_COPY.historyHint}</span>
      </div>
      {task.recent.length ? (
        <ol className="space-y-2">
          {shown.map((r, i) => {
            const h = historyLine(r, { me: screen.me, names: page.names, origin: task.origin, brandName, timeZone: page.timeZone, today: screen.today, ideaWords: screen.ideaWords });
            return (
              <li key={`${r.at}${i}`} className="flex items-start gap-2 text-sm">
                <span aria-hidden className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-neutral-100 text-[10px] font-semibold dark:bg-neutral-800">
                  {h.vizzy ? <Sparkles size={12} /> : initialsOf(h.who)}
                </span>
                <div>
                  <p>
                    <span className="font-medium">{h.who}</span> {h.what}
                  </p>
                  <p className="text-xs text-neutral-500">{h.when}</p>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-neutral-500">{WORK_COPY.noHistory}</p>
      )}
      {cut ? (
        <button type="button" onClick={() => setAll(true)} className="text-xs text-neutral-500 underline underline-offset-4">
          {WORK_COPY.showAll}
        </button>
      ) : null}
    </section>
  );
}

/** Stage: one of the ten, or none. */
export function StageField({ value, disabled, onChange }: { value: CompanyStage | null; disabled: boolean; onChange: (stage: CompanyStage | null) => void }) {
  const mark = useFocusMark();
  return (
    <label className="block space-y-1">
      <span className={SIDE_LABEL}>Stage</span>
      <select aria-label="Stage" disabled={disabled} value={value ?? ""} onChange={(e) => onChange((e.target.value || null) as CompanyStage | null)} className={inputClass} data-qe={mark("stage")}>
        <option value="">No stage</option>
        {COMPANY_STAGES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.n} {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Brand: only brands kept in the task's region, and the whole business where the person may pick it. */
export function BrandField({ screen, page, value, disabled, onChange }: { screen: TaskScreen; page: WorkTaskPage; value: string | null; disabled: boolean; onChange: (brandId: string | null) => void }) {
  const mark = useFocusMark();
  if (!screen.multiBrand) return null;
  return (
    <label className="block space-y-1">
      <span className={SIDE_LABEL}>Brand</span>
      <select aria-label="Brand" disabled={disabled} value={value ?? "none"} onChange={(e) => onChange(e.target.value === "none" ? null : e.target.value)} className={inputClass} data-qe={mark("brand")}>
        {value && !screen.brandChoices.some((b) => b.id === value) ? <option value={value}>{page.brandName ?? "This brand"}</option> : null}
        {screen.brandChoices.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
        {screen.options.wholeBusiness ? <option value="none">Whole business</option> : null}
      </select>
    </label>
  );
}

/** The idea it became, or Make it an idea. The row passes `onAway` so either link waits for its saves first. */
export function IdeaField({ screen, task, page, onAway }: { screen: TaskScreen; task: WorkTask; page: WorkTaskPage; onAway?: (e: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const { word, ideaName } = taskBits(screen, task, page);
  const mark = useFocusMark();
  return (
    <div className="space-y-1">
      <p className={SIDE_LABEL}>{word.One}</p>
      {task.ideaId && task.ideaBrandId ? (
        task.ideaBrandId === screen.sessionBrand.id ? (
          <Link
            href={`/admin/launches/${encodeURIComponent(task.ideaId)}`}
            className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
            data-qe={mark("idea")}
            onClick={onAway ? (e) => onAway(e, `/admin/launches/${encodeURIComponent(task.ideaId!)}`) : undefined}
          >
            <Lightbulb size={14} aria-hidden />
            {ideaName(task.ideaBrandId, task.ideaId) ?? word.A}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1" data-qe={mark("idea")} tabIndex={mark("idea") ? -1 : undefined}>
            <Lightbulb size={14} aria-hidden />
            {ideaName(task.ideaBrandId, task.ideaId) ?? word.A}
          </span>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-neutral-500">None</span>
          {screen.makeIdeaHref ? (
            <Link
              href={screen.makeIdeaHref}
              title={WORK_COPY.makeIdeaHint}
              className="text-sm underline underline-offset-4"
              data-qe={mark("idea")}
              onClick={onAway ? (e) => onAway(e, screen.makeIdeaHref!) : undefined}
            >
              Make it {word.a}
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The check: what it is, and Change (or Add a check, or Move its date when the measure set it),
 * which opens its editor in place. The page passes its one change at a time and its busy; the
 * row passes its line of changes as `onSave` and `send`, and is never busy. `start` opens an
 * editor from outside (the row, when the Check cell is clicked).
 */
export function CheckField({
  screen,
  task,
  page,
  busy,
  onSave,
  onMoved,
  send,
  via = "work_page",
  start,
}: {
  screen: TaskScreen;
  task: WorkTask;
  page: WorkTaskPage;
  busy: boolean;
  onSave: Save<CheckInput | null>;
  onMoved: (notice: string) => void;
  send?: (body: CheckSend) => Promise<CheckAnswer>;
  via?: "work_page" | "work_list";
  start?: number;
}) {
  const { options } = screen;
  const tz = page.timeZone;
  const { byMeasure } = taskBits(screen, task, page);
  const zoneBrand = options.brands.find((b) => b.id === (task.brandId ?? task.addedFrom)) ?? options.brands[0];
  const mark = useFocusMark();
  const [checkEdit, setCheckEdit] = useState<"none" | "person" | "move">("none");
  const [checkDraft, setCheckDraft] = useState<CheckDraft>(blankCheck());
  const [seed, setSeed] = useState<CheckDraft>(blankCheck());
  const checkFocus = useFocusSwap(checkEdit !== "none");
  const openEditor = () => {
    setSeed(checkDraft);
    setCheckEdit(byMeasure ? "move" : "person");
  };
  useEffect(() => {
    // Only a new `start` opens it (the row counts its clicks on the Check cell), and never over one already open.
    if (start && checkEdit === "none") openEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  useRowEditor("check", checkEdit === "person" ? { label: WORK_COPY.rowCheckLabel, dirty: JSON.stringify(checkDraft) !== JSON.stringify(seed), close: () => setCheckEdit("none") } : null);
  return (
    <div className="space-y-1">
      <p id="wk-t-check-l" className={SIDE_LABEL}>Check</p>
      <p className={page.due ? "font-medium text-amber-700 dark:text-amber-300" : ""}>
        {task.check
          ? checkSideLine({ kind: task.check.kind, at: task.check.at, byMeasure, due: page.due, timeZone: tz, afterRef: screen.afterRef })
          : "None"}
      </p>
      {checkEdit === "move" ? (
        <div ref={checkFocus.form}>
          <MoveCheck taskRef={task.ref} today={screen.today} setAt={task.check?.setAt} onClose={() => setCheckEdit("none")} onMoved={onMoved} send={send} via={via} />
        </div>
      ) : checkEdit === "person" ? (
        <div ref={checkFocus.form} className="space-y-2">
          <CheckPicker id="wk-t-check" value={checkDraft} onChange={setCheckDraft} today={screen.today} timeZone={tz} brandName={zoneBrand?.name ?? page.brandName ?? screen.sessionBrand.name} openTasks={options.openTasks} />
          <div className="flex gap-2">
            <Button
              tone="primary"
              disabled={busy || checkInputOf(checkDraft, screen.today) === undefined}
              onClick={async () => {
                const c = checkInputOf(checkDraft, screen.today);
                if (c !== undefined && (await onSave(c))) setCheckEdit("none");
              }}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button onClick={() => setCheckEdit("none")}>Cancel</Button>
          </div>
        </div>
      ) : (
        <span ref={checkFocus.opener}>
          <button type="button" onClick={openEditor} className="text-xs text-neutral-500 underline underline-offset-4" data-qe={mark("check")}>
            {byMeasure ? "Move its date" : task.check ? "Change" : "Add a check"}
          </button>
        </span>
      )}
    </div>
  );
}

/**
 * Blocked by: the tasks it waits for, and Change (or Add), which opens the search in place. The
 * row passes `onGoto` so a blocker opens in place, and `start` to open the search from the cell.
 */
export function BlockedByField({
  screen,
  page,
  busy,
  onSave,
  onGoto,
  start,
}: {
  screen: TaskScreen;
  page: WorkTaskPage;
  busy: boolean;
  onSave: Save<number[]>;
  onGoto?: OnGoto;
  start?: number;
}) {
  const mark = useFocusMark();
  const [blockEdit, setBlockEdit] = useState(false);
  const [blockRefs, setBlockRefs] = useState<number[]>([]);
  const [seed, setSeed] = useState<number[]>([]);
  const blockFocus = useFocusSwap(blockEdit);
  const openEditor = () => {
    const refs = page.blockers.flatMap((b) => ("ref" in b ? [b.ref] : []));
    setBlockRefs(refs);
    setSeed(refs);
    setBlockEdit(true);
  };
  useEffect(() => {
    // Only a new `start` opens it (the row counts its clicks on the Blocked by cell), and never over one already open.
    if (start && !blockEdit) openEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  useRowEditor("blockedBy", blockEdit ? { label: WORK_COPY.rowBlockedLabel, dirty: blockRefs.join(",") !== seed.join(","), close: () => setBlockEdit(false) } : null);
  return (
    <div className="space-y-1">
      <p className={SIDE_LABEL}>Blocked by</p>
      {blockEdit ? (
        <div ref={blockFocus.form} className="space-y-2">
          <BlockedByPicker id="wk-t-block" refs={blockRefs} onChange={setBlockRefs} openTasks={screen.options.openTasks} />
          <div className="flex gap-2">
            <Button
              tone="primary"
              disabled={busy}
              onClick={async () => {
                if (await onSave(blockRefs)) setBlockEdit(false);
              }}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button onClick={() => setBlockEdit(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          {page.blockers.length ? (
            <ul className="space-y-1">
              {page.blockers.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-1.5">
                  {"ref" in b ? (
                    <>
                      <Link href={`/admin/work/${b.ref}`} className="underline underline-offset-4" onClick={onGoto ? (e) => onGoto(e, b.ref) : undefined}>
                        #{b.ref} {b.title}
                      </Link>
                      <Chip tone={WORK_STATUS_TONE[b.status]}>{WORK_STATUS_LABEL[b.status]}</Chip>
                    </>
                  ) : (
                    <span className="text-neutral-500">{"gone" in b ? WORK_COPY.deletedTask : "hidden" in b ? WORK_COPY.hiddenTask : WORK_COPY.unreadTask}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-neutral-500">Nothing</span>
          )}
          <span ref={blockFocus.opener} className="block">
            <button type="button" onClick={openEditor} className="block text-xs text-neutral-500 underline underline-offset-4" data-qe={mark("block")}>
              {page.blockers.length ? "Change" : "Add"}
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/** Must have: it has to happen before the business launches or opens. */
export function MustHaveField({ value, disabled, onChange }: { value: boolean; disabled: boolean; onChange: (mustHave: boolean) => void }) {
  const mark = useFocusMark();
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" disabled={disabled} checked={value} onChange={(e) => onChange(e.target.checked)} className="mt-1" data-qe={mark("must")} />
      <span>
        <span className="block font-medium">Must have</span>
        <span className="block text-xs text-neutral-500">{WORK_COPY.mustHaveHint}</span>
      </span>
    </label>
  );
}

/** How we'll know it worked, in its own card. */
export function MeasureCard({ screen, task, page, busy, onSave }: { screen: TaskScreen; task: WorkTask; page: WorkTaskPage; busy: boolean; onSave: Save<MeasureInput | null> }) {
  const { options } = screen;
  const { repos } = taskBits(screen, task, page);
  const mark = useFocusMark();
  return (
    <section aria-labelledby="wk-ms-h" className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800" data-qe={mark("measure")}>
      <h2 id="wk-ms-h" className="text-sm font-semibold">
        {WORK_COPY.measureTitle}
      </h2>
      <MeasureSection
        task={task}
        busy={busy}
        onSave={onSave}
        products={screen.measureBrand ? screen.measureBrand.products : null}
        meanings={options.meanings}
        operator={options.operator}
        runsInApp={repos.length > 0 || (screen.measureBrand?.products.length ?? 0) > 0}
        word={options.brands.find((b) => b.id === screen.measureBrand?.id)?.word ?? null}
        oneBrand={screen.oneBrand}
        ideaWords={screen.ideaWords}
      />
    </section>
  );
}
