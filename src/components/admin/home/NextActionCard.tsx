"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Check, RefreshCw, Sparkles, X } from "lucide-react";
import { useShell } from "../nav/ShellProvider";
import type { CardStepView, CardView } from "@/lib/nextAction/view";
import { NEXT_ACTION_WORDS as W } from "@/lib/nextAction/words";

/**
 * Home's Your next action as the card Vizzy wrote (NEXT_ACTION_CARD_ENABLED, ADR-0020), drawn with
 * our own pieces from the mockups: the steps with why, each step's button (a page from the server's
 * list, or a question for Vizzy in the chat below), a quick question inline, a goal, Dismiss with an
 * optional reason, and Show another. Home renders it on the server from the kept card; when that
 * card is out of date (`stale`) it asks for a new one once, and shows the steps list (`children`)
 * until a card comes. Admins only: the server never renders it for a member.
 */

type Outcome = "done" | "dismissed" | "answered";
type Posted = { status: number; body: Record<string, unknown> };

async function postJson(url: string, body: unknown, keepalive = false): Promise<Posted> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive, credentials: "same-origin" });
    return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { status: 0, body: {} };
  }
}

/** The card with one step changed or left out, its numbers and counts again. */
function withStep(view: CardView, key: string, change: (s: CardStepView) => CardStepView | null): CardView {
  const steps = view.steps.flatMap((s) => {
    if (s.key !== key) return [s];
    const next = change(s);
    return next ? [next] : [];
  });
  const numbered = steps.map((s, i) => ({ ...s, n: i + 1 }));
  return { ...view, steps: numbered, done: numbered.filter((s) => s.state !== "open").length, total: numbered.length };
}

const QUIET = "border border-shell-line text-shell-ink hover:bg-shell-hover";
const MAIN = "bg-shell-ink text-shell-side hover:opacity-90";
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-shell-accent focus-visible:ring-offset-1";

export function NextActionCard({ initial, stale, children }: { initial: CardView | null; stale: boolean; children?: ReactNode }) {
  const shell = useShell();
  const [view, setView] = useState<CardView | null>(initial);
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const asked = useRef(false);

  const compose = useCallback(async (reason: "state" | "another", retries = 1): Promise<void> => {
    setWriting(true);
    setMessage(null);
    if (reason === "state") setLive(W.writing);
    const r = await postJson("/api/admin/next-action", { reason });
    if (r.status === 200 && r.body.held === "busy" && retries > 0) {
      // Another tab is writing it: look once more shortly.
      window.setTimeout(() => void compose(reason, retries - 1), 6000);
      return;
    }
    if (r.status === 200) {
      const next = (r.body.view ?? null) as CardView | null;
      if (r.body.held === "limited" && reason === "another") setMessage(W.limited);
      else if (r.body.composed || reason === "state") setView(next);
      setLive(next ? W.ready : "");
    } else if (reason === "another") {
      setMessage(r.status === 429 ? W.tooFast : W.anotherFailed);
    }
    setWriting(false);
  }, []);

  useEffect(() => {
    if (!stale || asked.current) return;
    asked.current = true;
    void compose("state");
  }, [stale, compose]);

  const record = useCallback(
    async (step: CardStepView, outcome: Outcome, extra: { reason?: string; choice?: number } = {}, keepalive = false): Promise<Posted | null> => {
      if (!view) return null;
      return postJson("/api/admin/next-action/outcome", { cardId: view.cardId, step: step.key, outcome, ...extra }, keepalive);
    },
    [view],
  );

  /** After a step is decided: once none is open, Home's card is used up, so ask for a new one. */
  const settle = useCallback(
    (next: CardView) => {
      setView(next);
      if (!next.steps.some((s) => s.state === "open")) void compose("state");
    },
    [compose],
  );

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

  const firstOpen = view.steps.find((s) => s.state === "open")?.key;
  const firstButton = view.steps.find((s) => s.state === "open" && s.button)?.key;
  const pct = view.total ? Math.round((view.done / view.total) * 100) : 0;

  return (
    <section aria-labelledby="next-action-h" className="overflow-hidden rounded-xl border border-shell-line bg-shell-card">
      <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3.5">
        <h2 id="next-action-h" className="text-sm font-semibold">
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

      {view.note ? (
        <p className="mx-4 mb-3 flex items-center gap-2.5 rounded-lg border border-[color:var(--ob-ok-line)] bg-[color:var(--ob-ok-bg)] px-3 py-2 text-[13px] leading-[18px] text-[color:var(--ob-ok-text)]">
          <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-[color:var(--ob-ok-text)] text-[color:var(--ob-ok-bg)]">
            <Check size={12} strokeWidth={3} aria-hidden />
          </span>
          <span className="min-w-0">{view.note.text}</span>
          {view.note.today ? <span className="ml-auto shrink-0 text-xs opacity-80">{W.doneToday}</span> : null}
        </p>
      ) : null}

      <ol className="flex flex-col">
        {view.steps.map((step) => (
          <StepRow
            key={step.key}
            step={step}
            next={step.key === firstOpen}
            main={step.key === firstButton}
            canAsk={!!shell}
            onPage={() => {
              // The page opens at once; the record goes with it.
              void record(step, "done", {}, true);
            }}
            onAsk={() => {
              if (!step.button?.prompt) return;
              shell?.ask(step.button.prompt);
              void record(step, "done");
              settle(withStep(view, step.key, (s) => ({ ...s, state: "done" })));
            }}
            onAnswer={async (choice) => {
              const label = step.question?.options[choice] ?? null;
              const r = await record(step, "answered", { choice });
              if (!r || r.status !== 200) return { ok: false, line: r?.status === 409 ? W.cardChanged : W.saveFailed };
              const line = r.body.suggestion === "waiting" ? W.answerWaiting : r.body.suggestion === "already_known" ? W.answerKnown : W.answerGot;
              settle(withStep(view, step.key, (s) => ({ ...s, state: "answered", question: s.question ? { ...s.question, picked: label } : null })));
              return { ok: true, line };
            }}
            onDismiss={async (reason) => {
              const r = await record(step, "dismissed", reason ? { reason } : {});
              if (!r || r.status !== 200) {
                setMessage(r?.status === 409 ? W.cardChanged : W.saveFailed);
                return false;
              }
              setLive(W.dismissed);
              const next = withStep(view, step.key, () => null);
              if (next.steps.length) settle(next);
              else {
                setView(null);
                void compose("state");
              }
              return true;
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
          onClick={() => void compose("another")}
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
  const open = step.state === "open";

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
  const button =
    open && step.button ? (
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
          !open ? "bg-shell-ink text-shell-side" : next ? "border-2 border-shell-accent text-shell-accent" : "border border-shell-faint text-shell-muted"
        }`}
      >
        {open ? step.n : <Check size={12} strokeWidth={3} aria-label={W.done} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${open ? "text-shell-ink" : "text-shell-muted"}`}>{step.title}</p>
          <p className="mt-0.5 text-[13px] leading-[18px] text-shell-muted">{step.why}</p>

          {step.question ? (
            <>
              <div role="group" aria-label={step.question.label} className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-medium text-shell-ink">{step.question.label}</span>
                {step.question.options.map((label, i) => {
                  const picked = step.question?.picked === label;
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={picked}
                      disabled={!open || busy}
                      onClick={async () => {
                        setBusy(true);
                        const r = await onAnswer(i);
                        setBusy(false);
                        setAnswerLine(r.line);
                      }}
                      className={`rounded-full border px-3 py-1 text-[13px] ${
                        picked ? "border-shell-ink bg-shell-ink text-shell-side" : "border-shell-line bg-shell-card text-shell-ink hover:border-shell-ink"
                      } disabled:cursor-default ${FOCUS}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {answerLine ? (
                <p role="status" className="mt-1.5 text-xs text-shell-faint">
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
          {!open ? <span className="text-xs text-shell-faint">{W.done}</span> : null}
          {open ? (
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
          ) : null}
        </div>
      </div>
    </li>
  );
}
