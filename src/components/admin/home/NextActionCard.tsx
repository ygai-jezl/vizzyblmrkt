"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Check, RefreshCw, Sparkles, X } from "lucide-react";
import { useShell } from "../nav/ShellProvider";
import type { CardStepView, CardView } from "@/lib/nextAction/view";
import { NEXT_ACTION_WORDS as W } from "@/lib/nextAction/words";
import { NextActionFlow, type Posted } from "./nextActionFlow";

/**
 * Home's Your next action as the card Vizzy wrote (NEXT_ACTION_CARD_ENABLED, ADR-0022), drawn with
 * our own pieces from the mockups: what was done as green notes first, then the open steps with
 * why, each step's button (a page from the server's list, or a question for Vizzy in the chat below),
 * a quick question inline, a goal, Dismiss with an optional reason, and Show another. Home renders it
 * on the server from the kept card; when that card is out of date (`stale`) it asks for a new one
 * once, and shows the steps list (`children`) until a card comes. What a press does is in
 * nextActionFlow.ts. Admins only: the server never renders it for a member.
 */

async function postJson(url: string, body: unknown, keepalive = false): Promise<Posted> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive, credentials: "same-origin" });
    return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { status: 0, body: {} };
  }
}

const QUIET = "border border-shell-line text-shell-ink hover:bg-shell-hover";
const MAIN = "bg-shell-ink text-shell-side hover:opacity-90";
// The ring's offset takes the card's colour, so focus shows no white halo in the dark shell.
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-shell-accent focus-visible:ring-offset-1 focus-visible:ring-offset-shell-card";
const DONE_NOTE =
  "mx-4 mb-2 flex items-center gap-2.5 rounded-lg border border-[color:var(--ob-ok-line)] bg-[color:var(--ob-ok-bg)] px-3 py-2 text-[13px] leading-[18px] text-[color:var(--ob-ok-text)]";

/** One green note: the card before's note, or a step done or answered on this card. */
function DoneNote({ text, today }: { text: string; today: boolean }) {
  return (
    <li className={DONE_NOTE}>
      <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[color:var(--ob-ok-text)] text-[color:var(--ob-ok-bg)]">
        <Check size={12} strokeWidth={3} aria-hidden />
      </span>
      <span className="min-w-0">{text}</span>
      {today ? <span className="ml-auto shrink-0 text-xs opacity-80">{W.doneToday}</span> : null}
    </li>
  );
}

/** A done step's note: its title, and the answer picked. */
const doneText = (s: CardStepView) => (s.question?.picked ? `${s.title}: ${s.question.picked}` : s.title);

export function NextActionCard({ initial, stale, children }: { initial: CardView | null; stale: boolean; children?: ReactNode }) {
  const shell = useShell();
  const [flow] = useState(() => new NextActionFlow(initial, { post: postJson }));
  const { view, writing, message, notice, live } = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  const asked = useRef(false);
  // A saved answer or dismissal takes its row away: focus goes to the card's heading, not the page.
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!stale || asked.current) return;
    asked.current = true;
    void flow.compose("state");
  }, [stale, flow]);

  if (!view) {
    return (
      <>
        {children}
        <p className="sr-only" role="status" aria-live="polite">
          {writing ? W.writing : live}
        </p>
      </>
    );
  }

  const decided = view.steps.filter((s) => s.state !== "open");
  const open = view.steps.filter((s) => s.state === "open");
  const firstButton = open.find((s) => s.button)?.key;
  const pct = view.total ? Math.round((view.done / view.total) * 100) : 0;
  const cardId = view.cardId;

  return (
    <section aria-labelledby="next-action-h" className="overflow-hidden rounded-xl border border-shell-line bg-shell-card">
      <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3.5">
        <h2 id="next-action-h" ref={heading} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
          {W.title}
        </h2>
        <span className="inline-flex items-center gap-2 text-xs tabular-nums text-shell-muted">
          {W.progress(view.done, view.total)}
          <span
            role="progressbar"
            aria-label={W.progressLabel}
            aria-valuemin={0}
            aria-valuemax={view.total}
            aria-valuenow={view.done}
            className="block h-1 w-[72px] overflow-hidden rounded-full bg-shell-line"
          >
            <span className="block h-full rounded-full bg-shell-accent" style={{ width: `${pct}%` }} />
          </span>
        </span>
      </div>

      {view.note || decided.length ? (
        <ul aria-label={W.doneLabel} className="flex flex-col pb-1">
          {view.note ? <DoneNote text={view.note.text} today={view.note.today} /> : null}
          {decided.map((s) => (
            <DoneNote key={`${cardId}:${s.key}`} text={doneText(s)} today={s.today} />
          ))}
        </ul>
      ) : null}

      {notice ? (
        <p role="status" className="mx-4 mb-2 text-xs text-shell-faint">
          {notice}
        </p>
      ) : null}

      <ol className="flex flex-col">
        {open.map((step, i) => (
          <StepRow
            // Keyed by card too, so a new card never inherits a row's open form or answer.
            key={`${cardId}:${step.key}`}
            step={step}
            next={i === 0}
            main={step.key === firstButton}
            canAsk={!!shell}
            onPage={() => flow.page(cardId, step)}
            onAsk={() => void flow.ask(cardId, step, (prompt) => shell?.ask(prompt))}
            onAnswer={async (choice) => {
              const r = await flow.answer(cardId, step, choice);
              if (r.ok) heading.current?.focus();
              return r;
            }}
            onDismiss={async (reason) => {
              const ok = await flow.dismiss(cardId, step, reason);
              if (ok) heading.current?.focus();
              return ok;
            }}
          />
        ))}
      </ol>

      {message ? (
        <p role="alert" className="border-t border-shell-line px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          {message}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-shell-line bg-shell-side px-4 py-2.5 text-xs text-shell-muted">
        <span className="inline-flex items-center gap-1.5">
          <Sparkles size={13} aria-hidden className="text-shell-accent" />
          {W.from}
        </span>
        <button
          type="button"
          onClick={() => void flow.compose("another")}
          disabled={writing}
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50 ${FOCUS}`}
        >
          <RefreshCw size={13} aria-hidden className={writing ? "animate-spin motion-reduce:animate-none" : undefined} />
          {W.another}
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {writing ? W.writing : live}
      </p>
    </section>
  );
}

function StepRow({
  step,
  next,
  main,
  canAsk,
  onPage,
  onAsk,
  onAnswer,
  onDismiss,
}: {
  step: CardStepView;
  next: boolean;
  main: boolean;
  canAsk: boolean;
  onPage: () => void;
  onAsk: () => void;
  onAnswer: (choice: number) => Promise<{ ok: boolean; line: string }>;
  onDismiss: (reason: string) => Promise<boolean>;
}) {
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [answerLine, setAnswerLine] = useState<string | null>(null);

  useEffect(() => {
    if (dismissing) inputRef.current?.focus();
  }, [dismissing]);

  const cancel = () => {
    setDismissing(false);
    setReason("");
    dismissRef.current?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await onDismiss(reason.trim());
    setBusy(false);
    if (ok) setDismissing(false);
  };

  const btnClass = `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium ${main ? MAIN : QUIET} ${FOCUS}`;
  const button = step.button ? (
      step.button.href ? (
        <Link href={step.button.href} onClick={onPage} className={btnClass}>
          {step.button.label}
          <ArrowRight size={14} aria-hidden />
        </Link>
      ) : canAsk && step.button.prompt ? (
        <button type="button" onClick={onAsk} className={btnClass}>
          <Sparkles size={14} aria-hidden className={main ? undefined : "text-shell-accent"} />
          {step.button.label}
        </button>
      ) : null
    ) : null;

  const goalPct = step.goal ? Math.min(100, Math.round(((step.goal.now ?? 0) / step.goal.target) * 100)) : 0;

  return (
    <li className="flex items-start gap-3 border-t border-shell-line px-4 py-3.5">
      <span
        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${
          next ? "border-2 border-shell-accent text-shell-accent" : "border border-shell-faint text-shell-muted"
        }`}
      >
        {step.n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-shell-ink">{step.title}</p>
          <p className="mt-0.5 text-[13px] leading-[18px] text-shell-muted">{step.why}</p>

          {step.question ? (
            <>
              <div role="group" aria-label={step.question.label} className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-medium text-shell-ink">{step.question.label}</span>
                {step.question.options.map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={false}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setAnswerLine(null);
                      const r = await onAnswer(i);
                      setBusy(false);
                      // A saved answer turns the step into a done note; only a failure stays here.
                      if (!r.ok) setAnswerLine(r.line);
                    }}
                    className={`rounded-full border border-shell-line bg-shell-card px-3 py-1 text-[13px] text-shell-ink hover:border-shell-ink disabled:cursor-default ${FOCUS}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {answerLine ? (
                <p role="alert" className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
                  {answerLine}
                </p>
              ) : null}
            </>
          ) : null}

          {step.goal ? (
            <p className="mt-2.5 flex items-center gap-2.5 text-xs tabular-nums text-shell-muted">
              <span
                role="progressbar"
                aria-label={step.title}
                aria-valuemin={0}
                aria-valuemax={step.goal.target}
                aria-valuenow={Math.min(step.goal.now ?? 0, step.goal.target)}
                className="block h-1.5 w-full max-w-[200px] overflow-hidden rounded-full bg-shell-line"
              >
                <span className="block h-full rounded-full bg-shell-accent" style={{ width: `${goalPct}%` }} />
              </span>
              {W.goal(step.goal.now, step.goal.target)}
            </p>
          ) : null}

          {dismissing ? (
            <form id={formId} onSubmit={submit} className="mt-2.5 flex flex-wrap items-end gap-2">
              <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs font-medium text-shell-ink">
                {W.reasonLabel}
                <input
                  ref={inputRef}
                  value={reason}
                  maxLength={140}
                  placeholder={W.reasonPlaceholder}
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancel();
                    }
                  }}
                  className={`rounded-md border border-shell-line bg-shell-card px-2.5 py-1.5 text-[13px] font-normal text-shell-ink placeholder:text-shell-faint ${FOCUS}`}
                />
              </label>
              <button type="submit" disabled={busy} className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${MAIN} disabled:opacity-50 ${FOCUS}`}>
                {W.dismiss}
              </button>
              <button type="button" onClick={cancel} className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${QUIET} ${FOCUS}`}>
                {W.cancel}
              </button>
            </form>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {button}
          <button
            ref={dismissRef}
            type="button"
            aria-label={W.dismissLabel(step.title)}
            aria-expanded={dismissing}
            aria-controls={dismissing ? formId : undefined}
            onClick={() => (dismissing ? cancel() : setDismissing(true))}
            className={`grid h-7 w-7 place-items-center rounded-md text-shell-faint hover:bg-shell-hover hover:text-shell-ink ${FOCUS}`}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </div>
    </li>
  );
}
