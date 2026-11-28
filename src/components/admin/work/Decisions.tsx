"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, Sparkles } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { Chip } from "@/components/admin/people/Chip";
import { initialsOf, whenWords, whoWords, WORK_COPY } from "@/lib/work/screenWords";
import { isPlanApprovalQuestion, PLAN_APPROVAL_OPTIONS, WORK_LIMITS, type DecisionOptionId, type TypedLink, type WorkLogRowOf } from "@/lib/work/types";
import { PLAN_STATE_LABEL } from "@/lib/work/words";
import { DRAFT_COPY } from "@/lib/work/draft";
import type { DraftedDecision } from "@/lib/work/screens";
import { workCall, workErrorText } from "./api";
import { useRowEditor } from "./rowEditors";
import { useFocusSwap } from "./useFocusSwap";

type DecisionRow = WorkLogRowOf<"decision">;

export interface DecisionView {
  id: string;
  question: string;
  verdict: string;
  tone: "green" | "amber" | "neutral";
  when: string;
  plan: string | null;
  options: Array<{ id: DecisionOptionId; label: string; chosen: boolean; recommended: boolean }>;
  /** "Vizzy recommended “By link”." and why, or for a plan approval that no one does. */
  recommendation: { text: string; why: string; vizzy: boolean } | null;
  choice: { text: string; why: string; initials: string } | null;
  /** A later row changed this pick. */
  replaced: boolean;
  /** Its options' labels, to change the pick with. */
  labels: string[];
  isPlan: boolean;
}

/** A decision row as the task page draws it. Pure. */
export function decisionView(d: DecisionRow, o: { me: string; names: Readonly<Record<string, string>>; timeZone: string; today: string; typedLinks: readonly TypedLink[]; replacedIds: ReadonlySet<string> }): DecisionView {
  const dec = d.decision;
  const recBy = dec.recommended ? (dec.recommended.by.kind === "vizzy" ? "Vizzy" : (dec.recommended.by.name ?? "A coding agent")) : null;
  const label = (id: string | undefined) => dec.options.find((x) => x.id === id)?.label ?? "";
  const chooser = dec.chosen ? whoWords({ kind: "person", id: dec.chosen.by }, o.me, o.names) : null;
  const plan = dec.plan ? o.typedLinks.find((l) => l.kind === "plan" && l.url === dec.plan!.url) : undefined;
  const planTitle = dec.plan ? `${plan && plan.kind === "plan" ? plan.title : dec.plan.url}${dec.plan.version ? `, version ${dec.plan.version}` : ""}` : null;
  let verdict: string;
  let tone: DecisionView["tone"] = "neutral";
  if (dec.plan) {
    verdict = dec.chosen?.option === "a" ? PLAN_STATE_LABEL.approved : dec.chosen?.option === "b" ? PLAN_STATE_LABEL.change_it : PLAN_STATE_LABEL.not_now;
    tone = dec.chosen?.option === "a" ? "green" : dec.chosen?.option === "b" ? "amber" : "neutral";
  } else if (dec.recommended && dec.chosen) {
    verdict = dec.agreed ? `Agreed with ${recBy}` : `Overruled ${recBy}`;
    tone = dec.agreed ? "green" : "amber";
  } else verdict = dec.chosen ? "Decided" : "No pick yet";
  return {
    id: d.id,
    question: dec.question,
    verdict,
    tone,
    when: whenWords(d.at, o.timeZone, o.today),
    plan: planTitle,
    options: dec.options.map((x) => ({ id: x.id, label: x.label, chosen: dec.chosen?.option === x.id, recommended: dec.recommended?.option === x.id })),
    recommendation: dec.plan
      ? { text: WORK_COPY.planNoRecommendation, why: "", vizzy: false }
      : dec.recommended
        ? { text: `${recBy} recommended “${label(dec.recommended.option)}”.`, why: dec.recommended.reason, vizzy: dec.recommended.by.kind === "vizzy" }
        : null,
    choice: dec.chosen && chooser ? { text: `${chooser} chose “${label(dec.chosen.option)}”.`, why: dec.why ?? "", initials: initialsOf(chooser) } : null,
    replaced: o.replacedIds.has(d.id),
    labels: dec.options.map((x) => x.label),
    isPlan: dec.plan !== null,
  };
}

/** Decisions on a task, newest first, and the form to record one. Append only: a changed mind is a new row. */
export function Decisions({
  taskRef,
  decisions,
  typedLinks,
  me,
  names,
  timeZone,
  today,
  drafted = null,
}: {
  taskRef: number;
  decisions: DecisionRow[];
  typedLinks: TypedLink[];
  me: string;
  names: Record<string, string>;
  timeZone: string;
  today: string;
  /** A decision Vizzy drafted in chat, opened from its card. */
  drafted?: DraftedDecision | { gone: string } | null;
}) {
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  // Record a decision opens its form in place of the button: focus moves to the question, and back on Cancel.
  const focus = useFocusSwap(adding);
  const replacedIds = new Set(decisions.flatMap((d) => (d.decision.replaces ? [d.decision.replaces] : [])));
  const views = [...decisions].reverse().map((d) => decisionView(d, { me, names, timeZone, today, typedLinks, replacedIds }));
  return (
    <section id="decisions" aria-labelledby="wk-dec-h" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="wk-dec-h" className="text-sm font-semibold">
          Decisions
        </h2>
        {!adding && decisions.length < WORK_LIMITS.decisions ? (
          <span ref={focus.opener}>
            <Button onClick={() => setAdding(true)}>Record a decision</Button>
          </span>
        ) : null}
      </div>
      {drafted && "gone" in drafted ? (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {drafted.gone}
        </p>
      ) : drafted ? (
        <DraftedDecisionBox taskRef={taskRef} draft={drafted} />
      ) : null}
      {adding ? (
        <div ref={focus.form}>
          <DecisionForm taskRef={taskRef} onClose={() => setAdding(false)} />
        </div>
      ) : null}
      {views.length ? (
        <ol aria-label="Decisions, newest first" className="space-y-3">
          {views.map((v) => (
            <li key={v.id} className={`space-y-2 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800 ${v.replaced ? "opacity-70" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{v.question}</p>
                <Chip tone={v.tone}>{v.verdict}</Chip>
                {v.replaced ? <Chip>Changed later</Chip> : null}
                <span className="ml-auto text-xs text-neutral-500">{v.when}</span>
              </div>
              {v.plan ? <p className="text-xs text-neutral-500">Plan: {v.plan}</p> : null}
              <ul aria-label="Options" className="flex flex-wrap gap-1.5">
                {v.options.map((o) => (
                  <li key={o.id} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${o.chosen ? "border-neutral-900 font-medium dark:border-white" : "border-neutral-200 text-neutral-600 dark:border-neutral-800 dark:text-neutral-400"}`}>
                    {o.chosen ? (
                      <>
                        <Check size={12} aria-hidden />
                        <span className="sr-only">Chosen:</span>
                      </>
                    ) : null}
                    {o.label}
                    {o.recommended ? (
                      <span className="inline-flex items-center gap-0.5 text-sky-700 dark:text-sky-300">
                        <Sparkles size={10} aria-hidden />
                        {v.recommendation?.vizzy ? "Vizzy's pick" : "Recommended"}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {v.recommendation ? (
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  <strong>{v.recommendation.text}</strong> {v.recommendation.why}
                </p>
              ) : null}
              {v.choice ? (
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  <strong>{v.choice.text}</strong> {v.choice.why ? `Why: ${v.choice.why}` : ""}
                </p>
              ) : null}
              {!v.isPlan && !v.replaced ? <ChangePickToggle taskRef={taskRef} view={v} open={changing === v.id} onOpen={() => setChanging(v.id)} onClose={() => setChanging(null)} /> : null}
            </li>
          ))}
        </ol>
      ) : !adding ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{WORK_COPY.noDecisions}</p>
      ) : null}
    </section>
  );
}

function usePost(onDone: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const r = await workCall("/decisions", "POST", body);
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    onDone();
    router.refresh();
  };
  return { post, busy, error };
}

/** Record a decision: the question, 2 to 4 options, the pick (optional) and why (optional). */
export function DecisionForm({ taskRef, onClose }: { taskRef: number; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [why, setWhy] = useState("");
  const { post, busy, error } = usePost(onClose);
  // In the open row on Work's list, what's typed here is kept from being thrown away unasked.
  useRowEditor("decision", { label: WORK_COPY.rowDecisionLabel, dirty: !!(question.trim() || options.some((o) => o.trim()) || why.trim() || chosen !== null), close: onClose });
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const planAsked = isPlanApprovalQuestion(question);
  const ready = question.trim() && filled.length >= 2 && !planAsked;
  const save = () => {
    const ids = ["a", "b", "c", "d"] as const;
    const kept = options.map((o, i) => ({ o: o.trim(), i })).filter((x) => x.o);
    const at = chosen === null ? -1 : kept.findIndex((x) => x.i === chosen);
    void post({ ref: taskRef, question: question.trim(), options: kept.map((x) => x.o), ...(at >= 0 ? { chosen: ids[at] } : {}), ...(why.trim() ? { why: why.trim() } : {}) });
  };
  return (
    <div role="group" aria-label="Record a decision" className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <input type="text" aria-label="Question" placeholder="The question, such as: Which supplier first?" maxLength={WORK_LIMITS.question} value={question} onChange={(e) => setQuestion(e.target.value)} className={inputClass} />
      {planAsked ? <p className="text-xs text-amber-700 dark:text-amber-300">{WORK_COPY.planQuestionHere}</p> : null}
      <div role="radiogroup" aria-label="Options, and the one you chose" className="space-y-1.5">
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-2">
            <input type="radio" name="wk-dec-chosen" aria-label={`Choose option ${i + 1}`} checked={chosen === i} onChange={() => setChosen(i)} />
            <input type="text" aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`} maxLength={WORK_LIMITS.optionLabel} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} className={inputClass} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {options.length < 4 ? (
          <button type="button" onClick={() => setOptions([...options, ""])} className="underline underline-offset-4">
            Add an option
          </button>
        ) : null}
        {chosen !== null ? (
          <button type="button" onClick={() => setChosen(null)} className="underline underline-offset-4">
            No pick yet
          </button>
        ) : null}
      </div>
      <input type="text" aria-label="Why (optional)" placeholder="Why (optional)" maxLength={WORK_LIMITS.why} value={why} onChange={(e) => setWhy(e.target.value)} className={inputClass} />
      {error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button tone="primary" disabled={!ready || busy} onClick={save}>
          {busy ? "Saving…" : "Save the decision"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

/** Change the pick, and the form it opens in its place: focus moves to the options, and back on Cancel. */
function ChangePickToggle({ taskRef, view, open, onOpen, onClose }: { taskRef: number; view: DecisionView; open: boolean; onOpen: () => void; onClose: () => void }) {
  const focus = useFocusSwap(open);
  return open ? (
    <div ref={focus.form}>
      <ChangePick taskRef={taskRef} view={view} onClose={onClose} />
    </div>
  ) : (
    <button ref={focus.opener} type="button" onClick={onOpen} className="text-xs text-neutral-500 underline underline-offset-4">
      Change the pick
    </button>
  );
}

/** A changed mind on a decision: a new row that names the one it replaces. */
function ChangePick({ taskRef, view, onClose }: { taskRef: number; view: DecisionView; onClose: () => void }) {
  const [chosen, setChosen] = useState<DecisionOptionId | null>(null);
  const [why, setWhy] = useState("");
  const { post, busy, error } = usePost(onClose);
  useRowEditor(`pick:${view.id}`, { label: WORK_COPY.rowPickLabel, dirty: chosen !== null || !!why.trim(), close: onClose });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {view.options.map((o) => (
          <button key={o.id} type="button" aria-pressed={chosen === o.id} onClick={() => setChosen(o.id)} className={`rounded-md border px-2 py-0.5 text-xs ${chosen === o.id ? "border-neutral-900 font-medium dark:border-white" : "border-neutral-300 dark:border-neutral-700"}`}>
            {o.label}
          </button>
        ))}
      </div>
      <input type="text" aria-label="Why (optional)" placeholder="Why (optional)" maxLength={WORK_LIMITS.why} value={why} onChange={(e) => setWhy(e.target.value)} className={inputClass} />
      {error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button tone="primary" disabled={!chosen || busy} onClick={() => void post({ ref: taskRef, question: view.question, options: view.labels, chosen, replaces: view.id, ...(why.trim() ? { why: why.trim() } : {}) })}>
          {busy ? "Saving…" : "Save the new pick"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

/** Approve the plan: Approve, Change it or Not now, with why. No one recommends it; it is kept as a decision. */
export function ApprovePlan({ taskRef, url, version, onClose }: { taskRef: number; url: string; version: string | null; onClose: () => void }) {
  const [why, setWhy] = useState("");
  const { post, busy, error } = usePost(onClose);
  useRowEditor(`approve:${url}`, { label: WORK_COPY.rowApproveLabel, dirty: !!why.trim(), close: onClose });
  return (
    <div id="wk-approve" role="group" aria-labelledby="wk-approve-h" className="mt-2 space-y-2 rounded-md border border-neutral-200 p-2.5 dark:border-neutral-800">
      <p id="wk-approve-h" className="text-sm font-medium">
        {WORK_COPY.approveAsk}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {PLAN_APPROVAL_OPTIONS.map((o) => (
          <Button key={o.id} tone={o.id === "a" ? "primary" : "secondary"} disabled={busy} onClick={() => void post({ ref: taskRef, plan: { url, ...(version ? { version } : {}) }, chosen: o.id, ...(why.trim() ? { why: why.trim() } : {}) })}>
            {o.label}
          </Button>
        ))}
        <Button onClick={onClose}>Cancel</Button>
      </div>
      <input type="text" aria-label="Why (optional)" placeholder="Why (optional)" maxLength={WORK_LIMITS.why} value={why} onChange={(e) => setWhy(e.target.value)} className={inputClass} />
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.approveNote}</p>
      {error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A decision Vizzy drafted in chat: its question, options and pick with why, as Vizzy wrote them.
 * The person chooses (and may say why); saving records the decision with Vizzy's pick as its
 * recommendation. Leave it drops the draft from the page; it is set aside after 7 days.
 */
export function DraftedDecisionBox({ taskRef, draft }: { taskRef: number; draft: DraftedDecision }) {
  const router = useRouter();
  const pathname = usePathname();
  const [chosen, setChosen] = useState<DecisionOptionId | null>(null);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = draft.recommended ? draft.options.find((o) => o.id === draft.recommended!.option) : undefined;
  const leave = () => router.replace(pathname ?? `/admin/work/${taskRef}`);
  const save = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const r = await workCall("/decisions", "POST", { ref: taskRef, draft: { id: draft.id, rev: draft.rev }, chosen, ...(why.trim() ? { why: why.trim() } : {}) });
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    leave();
    router.refresh();
  };
  return (
    <div role="group" aria-labelledby="wk-drafted-h" className="space-y-2 rounded-lg border border-sky-200 bg-sky-50/50 p-3 text-sm dark:border-sky-900 dark:bg-sky-950/20">
      <p className="flex items-center gap-1.5 text-xs text-sky-800 dark:text-sky-200">
        <Sparkles size={12} aria-hidden />
        {DRAFT_COPY.decisionDrafted}
      </p>
      <p id="wk-drafted-h" className="font-medium">
        {draft.question}
      </p>
      <div role="radiogroup" aria-label="Options" className="flex flex-wrap gap-1.5">
        {draft.options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={chosen === o.id}
            onClick={() => setChosen(o.id)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${chosen === o.id ? "border-neutral-900 font-medium dark:border-white" : "border-neutral-300 dark:border-neutral-700"}`}
          >
            {o.label}
            {pick?.id === o.id ? (
              <span className="inline-flex items-center gap-0.5 text-sky-700 dark:text-sky-300">
                <Sparkles size={10} aria-hidden />
                {DRAFT_COPY.vizzyPick}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">{pick && draft.recommended ? <><strong>{`Vizzy recommended “${pick.label}”.`}</strong> {draft.recommended.reason}</> : DRAFT_COPY.noPick}</p>
      <input type="text" aria-label="Why (optional)" placeholder="Why (optional)" maxLength={WORK_LIMITS.why} value={why} onChange={(e) => setWhy(e.target.value)} className={inputClass} />
      {error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button tone="primary" disabled={!chosen || busy} onClick={() => void save()}>
          {busy ? "Saving…" : DRAFT_COPY.decisionSave}
        </Button>
        <Button onClick={leave}>{DRAFT_COPY.decisionLeave}</Button>
      </div>
    </div>
  );
}
