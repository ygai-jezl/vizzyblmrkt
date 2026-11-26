"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, GitCommitHorizontal, ListChecks, Scale, Sparkles } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { Chip } from "@/components/admin/people/Chip";
import { logLineOf } from "@/lib/work/form";
import {
  carryOverLabel,
  changeWords,
  checkSaidLine,
  dayNWords,
  dayTitle,
  ENTRY_STATE_LABEL,
  ENTRY_STATE_TONE,
  initialsOf,
  logRegionsDownText,
  planApprovalWords,
  planKeyOf,
  plural,
  railLabel,
  whoInline,
  whoWords,
  WORK_COPY,
} from "@/lib/work/screenWords";
import { ENTRY_STATES, WORK_LIMITS, type EntryState, type WorkLogRowOf } from "@/lib/work/types";
import { timeOf } from "@/lib/work/words";
import type { DraftedNote, LogScreen } from "@/lib/work/screens";
import { DRAFT_COPY } from "@/lib/work/draft";
import { carryOffer, type MovedTask } from "@/lib/work/day";
import { workCall, workErrorText } from "./api";
import { CheckActions } from "./CheckActions";

/**
 * What moved on a task that day, in words: "Nina moved it from To do to In progress; you set the
 * check". The idea's brand, which changes with the idea, goes unsaid, as in History.
 */
export function movedWords(m: MovedTask, o: { me: string; names: Readonly<Record<string, string>>; brandName: (id: string) => string | undefined; ideaWords?: boolean }): string {
  const rows = m.rows.filter((r) => r.kind === "check" || r.field !== "ideaBrandId");
  const shown = rows.slice(-3).map((r, i) => {
    const who = i === 0 ? whoWords(r.source.who, o.me, o.names) : whoInline(r.source.who, o.me, o.names);
    const what = r.kind === "check" ? changeWords("check", null, r.check.read ?? r.check.action) : changeWords(r.field, r.before, r.after, { brandName: o.brandName, tool: r.source.tool, ideaWords: o.ideaWords });
    return `${who} ${what}`;
  });
  const more = rows.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${plural(more, "more change", "more changes")}` : ""}.`;
}

/** A decision made that day, in words: "By email, by Nina. Vizzy's pick was By link." */
export function decisionWords(d: WorkLogRowOf<"decision">, o: { me: string; names: Readonly<Record<string, string>> }): string {
  const dec = d.decision;
  const label = (id: string | undefined) => dec.options.find((x) => x.id === id)?.label ?? "";
  if (!dec.chosen) return "No pick yet.";
  const who = whoInline({ kind: "person", id: dec.chosen.by }, o.me, o.names);
  const rec = dec.recommended ? (dec.agreed ? " Vizzy's pick." : ` ${dec.recommended.by.kind === "vizzy" ? "Vizzy" : "The coding agent"}'s pick was ${label(dec.recommended.option)}.`) : "";
  return `${label(dec.chosen.option)}, by ${who}.${rec}`;
}

/**
 * The Log (/admin/work/log): it opens on Today. A day rail, the workstreams still in flight (each
 * carries over until someone logs it Done, never retyped), the box to log one, today's checks due
 * with their buttons, the tasks that moved and the decisions made. Before anyone has logged today,
 * Nothing logged yet offers Carry over. A past day is read only.
 */
export function WorkLog({ screen }: { screen: LogScreen }) {
  const { day, me, names } = screen;
  // A check's answer on Today: kept here, since the answered check leaves the list when the page reads itself again.
  const [checkSaid, setCheckSaid] = useState<{ ref: number; notice: string } | null>(null);
  const tz = day.timeZone;
  const brandName = (id: string) => screen.brandNames[id];
  const today = day.today;
  const decisions = day.decisions;
  return (
    <div className="grid gap-6 md:grid-cols-[176px_minmax(0,1fr)]">
      <nav aria-label="Days" className="space-y-1">
        <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Days</p>
        {day.rail.map((r, i) => {
          const n = r.entries + r.moved + r.decisions;
          // The rail always starts at today.
          const href = i === 0 ? "/admin/work/log" : `/admin/work/log?day=${r.day}`;
          const here = r.day === day.day;
          return (
            <Link
              key={r.day}
              href={href}
              aria-current={here ? "date" : undefined}
              className={`flex items-center justify-between rounded-md px-2 py-1.5 text-sm ${here ? "bg-neutral-100 font-medium dark:bg-neutral-800" : "text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-900"}`}
            >
              <span>{railLabel(r.day)}</span>
              <span className="tabular-nums text-xs text-neutral-400">{n || ""}</span>
            </Link>
          );
        })}
      </nav>
      <div className="min-w-0 space-y-6">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            {dayTitle(day.day)}
            {today ? <Chip tone="blue">Today</Chip> : null}
          </h2>
          <p className="flex flex-wrap gap-x-4 text-sm text-neutral-500 dark:text-neutral-400">
            <span>
              <b className="text-neutral-800 dark:text-neutral-200">{day.inFlight.length}</b> in flight
            </span>
            <span>
              <b className="text-neutral-800 dark:text-neutral-200">{day.moved.length}</b> {day.moved.length === 1 ? "task moved" : "tasks moved"}
            </span>
            {today ? (
              <span>
                <b className="text-neutral-800 dark:text-neutral-200">{screen.checks.length}</b> {screen.checks.length === 1 ? "check due" : "checks due"}
              </span>
            ) : null}
            <span>
              <b className="text-neutral-800 dark:text-neutral-200">{decisions.length}</b> {decisions.length === 1 ? "decision" : "decisions"}
            </span>
          </p>
        </div>
        {screen.day.regionsDown.length ? (
          <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {logRegionsDownText(screen.day.regionsDown.map((d) => d.name))}
          </p>
        ) : null}
        {day.capped ? <p className="text-xs text-neutral-500">{WORK_COPY.logCapped}</p> : null}

        <section aria-labelledby="wk-ws-h" className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h3 id="wk-ws-h" className="text-sm font-semibold">
              In flight
            </h3>
            <span className="text-xs text-neutral-500">{today ? WORK_COPY.inFlightHint : WORK_COPY.pastDayHint}</span>
          </div>
          {today && screen.draft && "gone" in screen.draft ? (
            <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {screen.draft.gone}
            </p>
          ) : null}
          {today ? <LogBox key={screen.draft && "id" in screen.draft ? screen.draft.id : "box"} screen={screen} draft={screen.draft && "id" in screen.draft ? screen.draft : null} /> : null}
          {carryOffer(day) ? <NothingLoggedYet day={day.day} count={carryOffer(day)} /> : null}
          {day.inFlight.length ? (
            <ul className="space-y-2">
              {day.inFlight.map((f) => {
                const who = whoWords(f.by, me, names);
                const task = f.taskId ? day.tasks[f.taskId] : undefined;
                return (
                  <li key={`${f.brandId ?? ""}${f.workstream}`} className="flex items-start gap-2 rounded-md border border-neutral-200 p-2.5 text-sm dark:border-neutral-800">
                    <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-neutral-100 text-[10px] font-semibold dark:bg-neutral-800">
                      {initialsOf(who)}
                    </span>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{f.workstream}</span>
                        <Chip tone={ENTRY_STATE_TONE[f.state]}>{ENTRY_STATE_LABEL[f.state]}</Chip>
                        <span title="Days in flight" className="text-xs text-neutral-500">
                          {dayNWords(f.dayN, f.longer)}
                        </span>
                      </p>
                      {f.note ? <p className="text-neutral-600 dark:text-neutral-300">{f.note}</p> : null}
                      <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                        <span>{who}</span>
                        {screen.multiBrand ? <span>{f.brandId ? (brandName(f.brandId) ?? "") : "Whole business"}</span> : null}
                        {task ? (
                          <Link href={`/admin/work/${task.ref}`} className="underline underline-offset-4">
                            #{task.ref} {task.title}
                          </Link>
                        ) : null}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-neutral-500">{timeOf(f.at, tz)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">{today ? WORK_COPY.nothingInFlight : WORK_COPY.nothingInFlightPast}</p>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          {today ? (
            <section aria-labelledby="wk-chk-h" className="space-y-2">
              <h3 id="wk-chk-h" className="flex items-center gap-1.5 text-sm font-semibold">
                <CalendarClock size={14} aria-hidden />
                Checks due
              </h3>
              {checkSaid ? (
                <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
                  {checkSaidLine(checkSaid.ref, checkSaid.notice)}
                </p>
              ) : null}
              {screen.checks.length ? (
                <ul className="space-y-2">
                  {screen.checks.map((c) => (
                    <li key={c.ref} className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50/50 p-2.5 text-sm dark:border-amber-900 dark:bg-amber-950/20">
                      <Link href={`/admin/work/${c.ref}`} className="font-medium hover:underline">
                        <span className="mr-1 tabular-nums text-neutral-500">#{c.ref}</span>
                        {c.title}
                      </Link>
                      <p className="text-neutral-600 dark:text-neutral-300">{c.byMeasure ? `Did it work? ${c.line}` : c.line}</p>
                      <CheckActions taskRef={c.ref} byMeasure={c.byMeasure} via="today" setAt={c.setAt || undefined} compact onSaid={(notice) => setCheckSaid({ ref: c.ref, notice })} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-neutral-500">{WORK_COPY.noChecks}</p>
              )}
            </section>
          ) : null}
          <section aria-labelledby="wk-mv-h" className="space-y-2">
            <h3 id="wk-mv-h" className="flex items-center gap-1.5 text-sm font-semibold">
              <GitCommitHorizontal size={14} aria-hidden />
              Tasks that moved
            </h3>
            {day.moved.length ? (
              <ul className="space-y-2">
                {day.moved.map((m) => {
                  const t = day.tasks[m.taskId];
                  return (
                    <li key={m.taskId} className="flex items-start gap-2 text-sm">
                      <span className="min-w-0 flex-1">
                        {t ? (
                          <Link href={`/admin/work/${t.ref}`} className="font-medium hover:underline">
                            <span className="mr-1 tabular-nums text-neutral-500">#{t.ref}</span>
                            {t.title}
                          </Link>
                        ) : (
                          <span className="font-medium text-neutral-500">{WORK_COPY.hiddenTask}</span>
                        )}
                        <span className="block text-xs text-neutral-500">{movedWords(m, { me, names, brandName, ideaWords: screen.ideaWords })}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-neutral-500">{timeOf(m.at, tz)}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-neutral-500">{today ? WORK_COPY.nothingMoved : WORK_COPY.nothingMovedPast}</p>
            )}
          </section>
        </div>

        <section aria-labelledby="wk-dec-h" className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 id="wk-dec-h" className="flex items-center gap-1.5 text-sm font-semibold">
              <Scale size={14} aria-hidden />
              Decisions made
            </h3>
            <span className="text-xs text-neutral-500">On tasks, plan approvals among them</span>
          </div>
          {decisions.length ? (
            <ul className="space-y-2">
              {decisions.map((d) => {
                const t = day.tasks[d.taskId];
                return (
                  <li key={d.id} className="flex items-start gap-2 text-sm">
                    <ListChecks size={14} aria-hidden className="mt-1 shrink-0 text-neutral-400" />
                    <span className="min-w-0 flex-1">
                      {t ? (
                        <Link href={`/admin/work/${t.ref}`} className="font-medium hover:underline">
                          <span className="mr-1 tabular-nums text-neutral-500">#{t.ref}</span>
                          {t.title}
                        </Link>
                      ) : null}
                      <span className="block">
                        <b>{/\?$/.test(d.decision.question) ? d.decision.question : `${d.decision.question}:`}</b> {decisionWords(d, { me, names })}
                      </span>
                      {d.decision.plan ? (
                        <span className="block text-xs text-neutral-500">
                          Plan:{" "}
                          <a href={d.decision.plan.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                            {planApprovalWords(d.decision.plan, day.planTitles[planKeyOf(d.decision.plan.url, d.decision.plan.version)])}
                          </a>
                        </span>
                      ) : null}
                      {d.decision.why ? <span className="block text-xs text-neutral-500">Why: {d.decision.why}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-neutral-500">{timeOf(d.at, tz)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-neutral-500">{today ? WORK_COPY.noDecisionsToday : WORK_COPY.noDecisionsPast}</p>
          )}
        </section>

        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {WORK_COPY.logFoot}
          {screen.workVizzy ? ` ${WORK_COPY.logVizzyFoot}` : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * Nothing logged yet, on Today: what the canvas draws before anyone has logged, with Carry over,
 * which logs today's entry for each workstream still open from yesterday, by the person who taps.
 * The count is the server's, worked out as the carry works it out; the page reads itself again after.
 */
export function NothingLoggedYet({ day, count }: { day: string; count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function carry() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await workCall("/log/carry", "POST", { day });
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    router.refresh();
  }

  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-6 text-center">
      <p className="max-w-md text-sm text-neutral-500 dark:text-neutral-400">{WORK_COPY.nothingLoggedToday}</p>
      <Button type="button" tone="primary" onClick={carry} disabled={busy}>
        {busy ? WORK_COPY.carrying : carryOverLabel(count)}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Log box: one line per workstream ("Pricing page: copy done"), its state, and the task it is
 * about. Opened from a note Vizzy drafted in chat, it starts filled with the draft, which the
 * person can change before saving it to today's log; Leave it empties the box.
 */
export function LogBox({ screen, draft = null }: { screen: Pick<LogScreen, "openTasks" | "logBrands" | "wholeBusiness" | "multiBrand" | "sessionBrand">; draft?: DraftedNote | null }) {
  const router = useRouter();
  const [text, setText] = useState(draft?.line ?? "");
  const [state, setState] = useState<EntryState>(draft?.state ?? "doing");
  const [ref, setRef] = useState<number | null>(draft?.ref ?? null);
  const [brandId, setBrandId] = useState<string>(draft ? (draft.brandId ?? "none") : screen.sessionBrand.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const line = logLineOf(text);
  const leave = () => router.replace("/admin/work/log");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!line || busy) return;
    setBusy(true);
    setError(null);
    const r = await workCall("/log", "POST", {
      workstream: line.workstream,
      state,
      ...(line.note ? { note: line.note } : {}),
      ...(ref ? { ref } : {}),
      ...(screen.multiBrand && !ref ? { brandId: brandId === "none" ? null : brandId } : {}),
      ...(draft ? { brandId: ref ? undefined : brandId === "none" ? null : brandId, links: draft.links, draft: { id: draft.id, rev: draft.rev } } : {}),
    });
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    setText("");
    setState("doing");
    setRef(null);
    if (draft) leave();
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      {draft ? (
        <p className="flex items-center gap-1.5 text-xs text-sky-800 dark:text-sky-200">
          <Sparkles size={12} aria-hidden />
          {DRAFT_COPY.logDrafted}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          aria-label="Log what you're working on"
          placeholder={WORK_COPY.logPlaceholder}
          maxLength={WORK_LIMITS.workstream + WORK_LIMITS.entryNote + 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`${inputClass} min-w-[18rem] flex-1`}
        />
        <select aria-label="State" value={state} onChange={(e) => setState(e.target.value as EntryState)} className={`${inputClass} w-auto`}>
          {ENTRY_STATES.map((s) => (
            <option key={s} value={s}>
              {ENTRY_STATE_LABEL[s]}
            </option>
          ))}
        </select>
        <Button type="submit" tone="primary" disabled={!line || busy}>
          {busy ? "Logging…" : draft ? DRAFT_COPY.logSave : "Log it"}
        </Button>
        {draft ? (
          <Button type="button" onClick={leave}>
            {DRAFT_COPY.logLeave}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="Task it is about" value={ref ?? ""} onChange={(e) => setRef(e.target.value ? Number(e.target.value) : null)} className={`${inputClass} w-auto max-w-xs`}>
          <option value="">No task</option>
          {screen.openTasks.map((t) => (
            <option key={t.ref} value={t.ref}>
              #{t.ref} {t.title}
            </option>
          ))}
        </select>
        {screen.multiBrand && !ref ? (
          <select aria-label="For" value={brandId} onChange={(e) => setBrandId(e.target.value)} className={`${inputClass} w-auto`}>
            {screen.logBrands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            {screen.wholeBusiness ? <option value="none">Whole business</option> : null}
          </select>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </form>
  );
}
