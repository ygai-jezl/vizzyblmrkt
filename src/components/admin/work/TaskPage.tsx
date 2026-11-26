"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, CalendarClock, Clock, FileText, Lightbulb, Link2, Sparkles, Upload } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { Chip, chipToneClass } from "@/components/admin/people/Chip";
import { ideaWord } from "@/lib/nav/terms";
import { blankCheck, checkInputOf, freeLinkWords, typedLinkHref, typedLinkWords, type CheckDraft } from "@/lib/work/form";
import {
  afterTaskDueLine,
  changeWords,
  checkSideLine,
  initialsOf,
  noLinksText,
  originParts,
  whenWords,
  whoInline,
  whoWords,
  WORK_COPY,
  WORK_STATUS_TONE,
} from "@/lib/work/screenWords";
import { COMPANY_STAGES, stageLabel, type CompanyStage } from "@/lib/work/stages";
import { SET_BY_MEASURE, WORK_LIMITS, WORK_STATUSES, type TypedLink, type WorkRecent, type WorkTask } from "@/lib/work/types";
import { dayOf, PLAN_STATE_LABEL, WORK_STATUS_LABEL } from "@/lib/work/words";
import type { TaskScreen } from "@/lib/work/screens";
import { workCall, workErrorText } from "./api";
import { CheckActions, MoveCheck } from "./CheckActions";
import { ApprovePlan, Decisions } from "./Decisions";
import { MeasureSection } from "./MeasureSection";
import { BlockedByPicker, CheckPicker, FreeLinksEditor, TypedLinksEditor } from "./TaskFields";
import { useTaskPatch } from "./useTaskPatch";

const SIDE_LABEL = "text-xs font-medium text-neutral-500 dark:text-neutral-400";

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

/**
 * One task (/admin/work/[ref]): its title and status, where it came from, a due check's buttons, its
 * description and notes, Connected to and Other links, its decisions and history; beside them its
 * stage, brand, idea, check, what it waits for, Must have and How we'll know it worked. Every change
 * goes through the task route and shows in History with who made it.
 */
export function TaskPage({ screen }: { screen: TaskScreen }) {
  const router = useRouter();
  const { page, options, me } = screen;
  const task = page.task;
  const tz = page.timeZone;
  const { patch, busy, error, notice } = useTaskPatch(task.ref);
  const [editText, setEditText] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [notes, setNotes] = useState(task.notes);
  const [linking, setLinking] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [checkEdit, setCheckEdit] = useState<"none" | "person" | "move">("none");
  const [checkDraft, setCheckDraft] = useState<CheckDraft>(blankCheck());
  const [blockEdit, setBlockEdit] = useState(false);
  const [blockRefs, setBlockRefs] = useState<number[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const brandName = (id: string) => [...options.brands, ...screen.brandChoices].find((b) => b.id === id)?.name;
  const ideaName = (b: string, i: string) => screen.ideaNames[`${b}:${i}`] ?? options.ideas.find((x) => x.value === `${b}:${i}`)?.label;
  const word = ideaWord(screen.ideaWords);
  const byMeasure = task.check?.setBy === SET_BY_MEASURE;
  const origin = originParts(task.origin, task.createdAt, tz, me, page.names, screen.suggested ? { from: screen.suggested.from, edited: screen.suggested.edited.length > 0 } : null);
  const repos = screen.measureBrand ? (options.brands.find((b) => b.id === screen.measureBrand!.id)?.repos ?? []) : options.brands.flatMap((b) => b.repos);
  const lastMove = task.recent.find((r) => r.field === "status");
  const open = task.status !== "done" && task.status !== "dropped";
  const waitingOn = page.waiting ? page.blockers.find((b): b is Extract<typeof b, { ref: number }> => "ref" in b && b.status !== "done" && b.status !== "dropped") : undefined;
  const meta = [task.stage ? stageLabel(task.stage) : null, screen.multiBrand ? (page.brandName ?? "Whole business") : null].filter(Boolean).join(" · ");
  const zoneBrand = options.brands.find((b) => b.id === (task.brandId ?? task.addedFrom)) ?? options.brands[0];

  const saveText = async () => {
    const body: Record<string, string> = {};
    if (title.trim() !== task.title) body.title = title.trim();
    if (description !== task.description) body.description = description;
    if (notes !== task.notes) body.notes = notes;
    if (!Object.keys(body).length || (await patch(body))) setEditText(false);
  };
  const remove = async () => {
    if (!window.confirm(WORK_COPY.deleteConfirm)) return;
    setDeleting(true);
    const r = await workCall(`/tasks/${task.ref}`, "DELETE");
    setDeleting(false);
    if (!r.ok) return setDeleteError(workErrorText(r.data));
    router.push("/admin/work");
    router.refresh();
  };
  const plans = new Map(page.plans.map((p) => [`${p.url}@${p.version ?? ""}`, p]));
  const decisionBy = (id: string | null) => page.decisions.find((d) => d.id === id);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-6">
        <Link href="/admin/work" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
          <ArrowLeft size={14} aria-hidden />
          All tasks
        </Link>
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-neutral-400">Task #{task.ref}</p>
          {editText ? (
            <input type="text" aria-label="Title" maxLength={WORK_LIMITS.title} value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} text-lg font-semibold`} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{task.title}</h1>
              {waitingOn ? <Chip tone="amber">Waiting on #{waitingOn.ref}</Chip> : null}
              {task.ideaId ? <Chip tone="violet">{screen.ideaWords ? "Now an idea" : "Now a launch"}</Chip> : null}
              {task.mustHave ? <Chip tone="violet">Must have</Chip> : null}
            </div>
          )}
          {meta ? <p className="text-sm text-neutral-500 dark:text-neutral-400">{meta}</p> : null}
          <p className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-neutral-100 text-[10px] font-semibold dark:bg-neutral-800">
              {task.origin.kind === "suggestion" ? <Sparkles size={12} /> : task.origin.kind === "import" ? <Upload size={12} /> : initialsOf(whoWords({ kind: "person", id: "by" in task.origin ? task.origin.by : null }, me, page.names))}
            </span>
            <span>
              <span className="font-medium">{origin.from}</span> {origin.rest}
            </span>
          </p>
          {screen.suggested?.edited.length ? (
            <details className="text-sm text-neutral-600 dark:text-neutral-300">
              <summary className="cursor-pointer font-medium">{WORK_COPY.vizzySuggested}</summary>
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
          ) : null}
        </div>

        {page.regionsDown.length ? (
          <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {WORK_COPY.taskRegionsDown}
          </p>
        ) : null}
        {page.due && task.check ? (
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
            <CheckActions taskRef={task.ref} byMeasure={byMeasure} via="work_page" />
          </div>
        ) : null}
        {waitingOn && open ? (
          <p role="status" className="flex items-start gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <Clock size={16} aria-hidden className="mt-0.5 shrink-0" />
            <span>
              <strong>
                Waiting on{" "}
                <Link href={`/admin/work/${waitingOn.ref}`} className="underline underline-offset-4">
                  #{waitingOn.ref} {waitingOn.title}
                </Link>
                .
              </strong>{" "}
              {WORK_COPY.blockedText}
            </span>
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="flex items-start gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : null}

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
                aria-checked={task.status === s}
                disabled={busy}
                onClick={() => (task.status === s ? null : void patch({ status: s }))}
                className={`rounded-md border px-2.5 py-1 text-sm ${task.status === s ? `border-neutral-900 font-medium dark:border-white ${chipToneClass(WORK_STATUS_TONE[s])}` : "border-neutral-300 dark:border-neutral-700"}`}
              >
                {WORK_STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          {lastMove ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Last moved by {whoInline(lastMove.who, me, page.names)} on {dayOf(lastMove.at, tz)}.
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className={SIDE_LABEL}>Description</p>
            {!editText ? (
              <button type="button" onClick={() => setEditText(true)} className="text-xs text-neutral-500 underline underline-offset-4">
                Edit
              </button>
            ) : null}
          </div>
          {editText ? (
            <>
              <textarea aria-label="Description" rows={4} maxLength={WORK_LIMITS.description} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
              <p className={SIDE_LABEL}>Notes</p>
              <textarea aria-label="Notes" rows={3} maxLength={WORK_LIMITS.notes} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
              <div className="flex gap-2">
                <Button tone="primary" disabled={busy || !title.trim()} onClick={() => void saveText()}>
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button
                  onClick={() => {
                    setTitle(task.title);
                    setDescription(task.description);
                    setNotes(task.notes);
                    setEditText(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              {task.description ? <DescriptionText text={task.description} /> : <p className="text-sm text-neutral-400">No description yet.</p>}
              <p className={SIDE_LABEL}>Notes</p>
              {task.notes ? <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">{task.notes}</p> : <p className="text-sm text-neutral-400">No notes yet.</p>}
            </>
          )}
        </div>

        <section aria-labelledby="wk-links-h" className="space-y-3">
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
                  onChange={(typedLinks) => void patch({ typedLinks })}
                  repos={repos}
                  ideas={options.ideas}
                  operator={options.operator}
                  loopsRepo={options.loopsRepo}
                  ideaName={ideaName}
                  ideaWords={screen.ideaWords}
                />
              </div>
              <div className="space-y-1">
                <p className={SIDE_LABEL}>Other links</p>
                <FreeLinksEditor links={task.links} onChange={(links) => void patch({ links })} hasRepo={repos.length > 0} />
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

        <Decisions taskRef={task.ref} decisions={page.decisions} typedLinks={task.typedLinks} me={me} names={page.names} timeZone={tz} today={screen.today} drafted={screen.draftedDecision} />

        <section aria-labelledby="wk-hist-h" className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="wk-hist-h" className="text-sm font-semibold">
              History
            </h2>
            <span className="text-xs text-neutral-500">{WORK_COPY.historyHint}</span>
          </div>
          {task.recent.length ? (
            <ol className="space-y-2">
              {task.recent
                .filter((r) => r.field !== "ideaBrandId")
                .map((r, i) => {
                  const h = historyLine(r, { me, names: page.names, origin: task.origin, brandName, timeZone: tz, today: screen.today, ideaWords: screen.ideaWords });
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
        </section>
      </div>

      <aside aria-label="Details" className="space-y-5">
        <div className="space-y-4 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <label className="block space-y-1">
            <span className={SIDE_LABEL}>Stage</span>
            <select aria-label="Stage" disabled={busy} value={task.stage ?? ""} onChange={(e) => void patch({ stage: (e.target.value || null) as CompanyStage | null })} className={inputClass}>
              <option value="">No stage</option>
              {COMPANY_STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.n} {s.label}
                </option>
              ))}
            </select>
          </label>
          {screen.multiBrand ? (
            <label className="block space-y-1">
              <span className={SIDE_LABEL}>Brand</span>
              <select aria-label="Brand" disabled={busy} value={task.brandId ?? "none"} onChange={(e) => void patch({ brandId: e.target.value === "none" ? null : e.target.value })} className={inputClass}>
                {task.brandId && !screen.brandChoices.some((b) => b.id === task.brandId) ? <option value={task.brandId}>{page.brandName ?? "This brand"}</option> : null}
                {screen.brandChoices.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                {options.wholeBusiness ? <option value="none">Whole business</option> : null}
              </select>
            </label>
          ) : null}
          <div className="space-y-1">
            <p className={SIDE_LABEL}>{word.One}</p>
            {task.ideaId && task.ideaBrandId ? (
              task.ideaBrandId === screen.sessionBrand.id ? (
                <Link href={`/admin/launches/${encodeURIComponent(task.ideaId)}`} className="inline-flex items-center gap-1 font-medium underline underline-offset-4">
                  <Lightbulb size={14} aria-hidden />
                  {ideaName(task.ideaBrandId, task.ideaId) ?? word.A}
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Lightbulb size={14} aria-hidden />
                  {ideaName(task.ideaBrandId, task.ideaId) ?? word.A}
                </span>
              )
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-neutral-500">None</span>
                {screen.makeIdeaHref ? (
                  <Link href={screen.makeIdeaHref} title={WORK_COPY.makeIdeaHint} className="text-sm underline underline-offset-4">
                    Make it {word.a}
                  </Link>
                ) : null}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <p id="wk-t-check-l" className={SIDE_LABEL}>Check</p>
            <p className={page.due ? "font-medium text-amber-700 dark:text-amber-300" : ""}>
              {task.check
                ? checkSideLine({ kind: task.check.kind, at: task.check.at, byMeasure, due: page.due, timeZone: tz, afterRef: screen.afterRef })
                : "None"}
            </p>
            {checkEdit === "move" ? (
              <MoveCheck taskRef={task.ref} today={screen.today} onClose={() => setCheckEdit("none")} />
            ) : checkEdit === "person" ? (
              <div className="space-y-2">
                <CheckPicker id="wk-t-check" value={checkDraft} onChange={setCheckDraft} today={screen.today} timeZone={tz} brandName={zoneBrand?.name ?? page.brandName ?? screen.sessionBrand.name} openTasks={options.openTasks} />
                <div className="flex gap-2">
                  <Button
                    tone="primary"
                    disabled={busy || checkInputOf(checkDraft, screen.today) === undefined}
                    onClick={async () => {
                      const c = checkInputOf(checkDraft, screen.today);
                      if (c !== undefined && (await patch({ check: c }))) setCheckEdit("none");
                    }}
                  >
                    {busy ? "Saving…" : "Save"}
                  </Button>
                  <Button onClick={() => setCheckEdit("none")}>Cancel</Button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setCheckEdit(byMeasure ? "move" : "person")} className="text-xs text-neutral-500 underline underline-offset-4">
                {byMeasure ? "Move its date" : task.check ? "Change" : "Add a check"}
              </button>
            )}
          </div>
          <div className="space-y-1">
            <p className={SIDE_LABEL}>Blocked by</p>
            {blockEdit ? (
              <div className="space-y-2">
                <BlockedByPicker id="wk-t-block" refs={blockRefs} onChange={setBlockRefs} openTasks={options.openTasks} />
                <div className="flex gap-2">
                  <Button
                    tone="primary"
                    disabled={busy}
                    onClick={async () => {
                      if (await patch({ blockedBy: blockRefs })) setBlockEdit(false);
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
                            <Link href={`/admin/work/${b.ref}`} className="underline underline-offset-4">
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
                <button
                  type="button"
                  onClick={() => {
                    setBlockRefs(page.blockers.flatMap((b) => ("ref" in b ? [b.ref] : [])));
                    setBlockEdit(true);
                  }}
                  className="block text-xs text-neutral-500 underline underline-offset-4"
                >
                  {page.blockers.length ? "Change" : "Add"}
                </button>
              </>
            )}
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" disabled={busy} checked={task.mustHave} onChange={(e) => void patch({ mustHave: e.target.checked })} className="mt-1" />
            <span>
              <span className="block font-medium">Must have</span>
              <span className="block text-xs text-neutral-500">{WORK_COPY.mustHaveHint}</span>
            </span>
          </label>
          <div className="space-y-1">
            <p className={SIDE_LABEL}>Ref</p>
            <p className="tabular-nums">#{task.ref}</p>
          </div>
        </div>
        <section aria-labelledby="wk-ms-h" className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 id="wk-ms-h" className="text-sm font-semibold">
            {WORK_COPY.measureTitle}
          </h2>
          <MeasureSection
            task={task}
            busy={busy}
            onSave={(measure) => patch({ measure })}
            products={screen.measureBrand ? screen.measureBrand.products : null}
            meanings={options.meanings}
            operator={options.operator}
            runsInApp={repos.length > 0 || (screen.measureBrand?.products.length ?? 0) > 0}
            word={options.brands.find((b) => b.id === screen.measureBrand?.id)?.word ?? null}
            oneBrand={screen.oneBrand}
            ideaWords={screen.ideaWords}
          />
        </section>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {screen.workVizzy ? `${WORK_COPY.vizzyFoot} ` : ""}
          {WORK_COPY.pageFoot}
        </p>
        {page.can.delete ? (
          <div className="space-y-1">
            <Button tone="danger" disabled={deleting} onClick={() => void remove()}>
              {deleting ? "Deleting…" : "Delete task"}
            </Button>
            {deleteError ? (
              <p role="alert" className="text-xs text-red-700 dark:text-red-400">
                {deleteError}
              </p>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
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
          <Button aria-expanded={false} aria-controls="wk-approve" onClick={onApprove}>
            Approve the plan
          </Button>
        ) : null}
      </div>
      {plan && approving ? <ApprovePlan taskRef={taskRef} url={plan.url} version={plan.version} onClose={onCloseApprove} /> : null}
    </li>
  );
}
