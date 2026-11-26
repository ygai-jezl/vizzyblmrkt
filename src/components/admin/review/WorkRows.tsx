"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Clock, Lightbulb, Play, Sparkles } from "lucide-react";
import { workCall, workErrorText } from "@/components/admin/work/api";
import type { ReviewItem } from "@/lib/review/summary";
import { checkDoneLine, READ_LABEL, READ_ORDER, startedLine, WORK_REVIEW_COPY as C, type CheckTap, type WorkReviewPayload } from "@/lib/work/reviewCards";
import { addedToWorkLine, DECLINE_WHY_CHOICES, dismissedLine } from "@/lib/work/suggestion";
import type { DeclineWhy } from "@/lib/types/agentAction";
import type { WorkRead, WorkStatus } from "@/lib/work/types";

/**
 * Review's Work rows (WORK_ENABLED), modelled on SignalActions: Checks due today, Ready to start
 * and Tasks Vizzy suggests. Members see them and act on them too (plan decision 7). Each row keeps
 * its own busy state and, once sent, a done line in its place; the sidebar's count catches up on
 * its next poll, since every route forgets the brand's cached count.
 */

const GHOST = "rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50";
const ACT = "shrink-0 rounded-md border border-shell-line px-3 py-1.5 text-sm font-medium hover:bg-shell-hover disabled:opacity-50";
const PRIMARY = "shrink-0 rounded-md bg-shell-ink px-3 py-1.5 text-sm font-medium text-shell-side hover:opacity-90 disabled:opacity-50";
const TAP = "rounded-md border border-shell-line px-2.5 py-1 text-xs font-medium hover:bg-shell-hover disabled:opacity-50";
const ROW = "flex items-start gap-3 rounded-lg border border-shell-line bg-shell-card px-4 py-3";
const ICON = "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-shell-hover text-shell-muted";

type Of<K extends WorkReviewPayload["kind"]> = ReviewItem & { work: Extract<WorkReviewPayload, { kind: K }> };

function DoneLine({ children }: { children: ReactNode }) {
  return (
    <li role="status" className="px-4 py-1 text-xs text-shell-muted">
      {children}
    </li>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-xs text-red-600 dark:text-red-400">
      {error}
    </p>
  ) : null;
}

// --- Checks due today --------------------------------------------------------------------------

/** What each check button says and whether it waits, while one is being sent (its key). */
export function checkCardButtons(measure: boolean, busy: string | null): Array<{ key: string; label: string; disabled: boolean }> {
  if (measure) return READ_ORDER.map((r) => ({ key: r, label: busy === r ? C.saving : READ_LABEL[r], disabled: busy !== null }));
  return [
    { key: "checked", label: busy === "checked" ? C.saving : C.done, disabled: busy !== null },
    { key: "look_again", label: busy === "look_again" ? C.saving : C.tomorrow, disabled: busy !== null },
  ];
}

const tapOf = (key: string): CheckTap => (key === "checked" ? { action: "checked" } : key === "look_again" ? { action: "look_again" } : { action: "read", read: key as WorkRead });

export function WorkCheckRow({ item }: { item: Of<"check"> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function send(key: string) {
    const tap = tapOf(key);
    setBusy(key);
    setError(null);
    const r = await workCall<{ notice: string | null }>("/checks", "POST", { ref: item.work.ref, ...tap, via: "review_check" });
    setBusy(null);
    if (!r.ok) return setError(workErrorText(r.data));
    setDone(checkDoneLine(item.work.ref, tap, r.data.notice ?? null));
  }
  if (done) return <DoneLine>{done}</DoneLine>;
  return <WorkCheckRowView item={item} busy={busy} error={error} onTap={(k) => void send(k)} />;
}

export function WorkCheckRowView({ item, busy, error, onTap }: { item: Of<"check">; busy: string | null; error: string | null; onTap: (key: string) => void }) {
  const buttons = checkCardButtons(item.work.measure, busy);
  const readsId = `wk-rd-${item.work.ref}`;
  return (
    <li className={ROW}>
      <span className={ICON} aria-hidden>
        <Clock size={14} />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium">{item.title}</p>
        <p className="text-xs text-shell-muted text-pretty">{item.detail}</p>
        {item.work.measure ? (
          <div role="group" aria-labelledby={readsId} className="flex flex-wrap items-center gap-1.5">
            <span id={readsId} className="text-xs font-medium">
              {C.yourRead}
            </span>
            {buttons.map((b) => (
              <button key={b.key} type="button" disabled={b.disabled} onClick={() => onTap(b.key)} className={TAP}>
                {b.label}
              </button>
            ))}
          </div>
        ) : null}
        <ErrorLine error={error} />
      </div>
      <span className="flex shrink-0 items-center gap-1">
        {!item.work.measure
          ? buttons.map((b) => (
              <button key={b.key} type="button" disabled={b.disabled} onClick={() => onTap(b.key)} className={GHOST}>
                {b.label}
              </button>
            ))
          : null}
        <Link href={item.href} className={ACT}>
          {C.open}
        </Link>
      </span>
    </li>
  );
}

// --- Ready to start ----------------------------------------------------------------------------

export function WorkReadyRow({ item }: { item: Of<"ready"> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function start() {
    setBusy(true);
    setError(null);
    // The pick is a change row with the tool review_ready, so a later learner can read which was started.
    const r = await workCall(`/tasks/${item.work.ref}`, "PATCH", { status: "in_progress", via: "review_ready" });
    setBusy(false);
    if (!r.ok) return setError(workErrorText(r.data));
    setDone(true);
  }
  if (done) return <DoneLine>{startedLine(item.work.ref, item.work.title)}</DoneLine>;
  return <WorkReadyRowView item={item} busy={busy} error={error} onStart={() => void start()} />;
}

export function WorkReadyRowView({ item, busy, error, onStart }: { item: Of<"ready">; busy: boolean; error: string | null; onStart: () => void }) {
  return (
    <li className={ROW}>
      <span className={ICON} aria-hidden>
        <Play size={14} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{item.title}</p>
        <p className="text-xs text-shell-muted text-pretty">{item.detail}</p>
        <ErrorLine error={error} />
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <button type="button" disabled={busy} onClick={onStart} className={ACT}>
          {busy ? C.starting : C.start}
        </button>
        <Link href={item.href} className={GHOST}>
          {C.open}
        </Link>
      </span>
    </li>
  );
}

// --- Tasks Vizzy suggests ----------------------------------------------------------------------

export type SuggestionBusy = "add" | "dismiss" | null;

/** What Add to Work and Dismiss say, and whether they wait: while one is sent, the other keeps its words. */
export function suggestionButtons(busy: SuggestionBusy): { add: { label: string; disabled: boolean }; dismiss: { label: string; disabled: boolean } } {
  return {
    add: { label: busy === "add" ? C.adding : C.addToWork, disabled: busy !== null },
    dismiss: { label: busy === "dismiss" ? C.dismissing : C.dismiss, disabled: busy !== null },
  };
}

type SuggestionDone = { kind: "added"; ref: number; title: string; status: WorkStatus } | { kind: "dismissed"; line: string };

export function WorkSuggestionRow({ item }: { item: Of<"suggestion"> }) {
  const [busy, setBusy] = useState<SuggestionBusy>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SuggestionDone | null>(null);
  const path = `/suggestions/${encodeURIComponent(item.work.actionId)}`;

  async function add() {
    setBusy("add");
    setError(null);
    const r = await workCall<{ task: { task: { ref: number; title: string; status: WorkStatus } } }>(path, "POST", { decision: "add", rev: item.work.rev });
    setBusy(null);
    if (!r.ok) return setError(workErrorText(r.data));
    const t = r.data.task.task;
    setDone({ kind: "added", ref: t.ref, title: t.title, status: t.status });
  }
  async function dismiss(why: DeclineWhy | null) {
    setBusy("dismiss");
    setError(null);
    const r = await workCall<{ line: string }>(path, "POST", { decision: "dismiss", rev: item.work.rev, ...(why ? { why } : {}) });
    setBusy(null);
    if (!r.ok) return setError(workErrorText(r.data));
    setDone({ kind: "dismissed", line: r.data.line ?? dismissedLine(item.work.title, why) });
  }

  if (done?.kind === "added") {
    return (
      <DoneLine>
        {addedToWorkLine(done.ref, done.title, done.status)}{" "}
        <Link href={`/admin/work/${done.ref}`} className="font-medium text-shell-ink underline underline-offset-4">
          {C.openIt}
        </Link>
      </DoneLine>
    );
  }
  if (done?.kind === "dismissed") return <DoneLine>{done.line}</DoneLine>;
  return (
    <WorkSuggestionRowView
      item={item}
      busy={busy}
      asking={asking}
      error={error}
      onAdd={() => void add()}
      onDismiss={() => setAsking(true)}
      onWhy={(why) => void dismiss(why)}
      onCancel={() => setAsking(false)}
    />
  );
}

export function WorkSuggestionRowView({
  item,
  busy,
  asking,
  error,
  onAdd,
  onDismiss,
  onWhy,
  onCancel,
}: {
  item: Of<"suggestion">;
  busy: SuggestionBusy;
  asking: boolean;
  error: string | null;
  onAdd: () => void;
  onDismiss: () => void;
  onWhy: (why: DeclineWhy | null) => void;
  onCancel: () => void;
}) {
  const s = item.work;
  const buttons = suggestionButtons(busy);
  const whyId = `wk-why-${s.actionId}`;
  return (
    <li className={ROW}>
      <span className={ICON} aria-hidden>
        <Sparkles size={14} />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium">{s.title}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-shell-muted">
          {s.stage ? (
            <span className="inline-flex items-center gap-1 rounded border border-shell-line px-1.5 py-0.5">
              <span className="tabular-nums" aria-hidden>
                {s.stage.n}
              </span>
              {s.stage.label}
            </span>
          ) : null}
          {s.brand ? <span>{s.brand}</span> : null}
          {s.ideas.map((idea) => (
            <span key={idea} className="inline-flex items-center gap-1">
              <Lightbulb size={12} aria-hidden />
              {idea}
            </span>
          ))}
          <span>{s.from}</span>
        </p>
        {s.why ? <p className="text-xs text-shell-ink text-pretty">{s.why}</p> : null}
        {s.measure ? (
          <p className="text-xs text-shell-muted text-pretty">
            <span className="font-medium text-shell-ink">{C.howWellKnow}</span> {s.measure.text}
            {s.measure.why ? ` ${s.measure.why}` : ""}
          </p>
        ) : null}
        {asking ? (
          <div role="group" aria-labelledby={whyId} className="flex flex-wrap items-center gap-1.5 pt-1">
            <span id={whyId} className="text-xs font-medium">
              {C.whyDismiss}
            </span>
            {DECLINE_WHY_CHOICES.map((r) => (
              <button key={r.why} type="button" disabled={busy !== null} onClick={() => onWhy(r.why)} className={TAP}>
                {r.label}
              </button>
            ))}
            <button type="button" disabled={busy !== null} onClick={() => onWhy(null)} className={GHOST}>
              {C.noReason}
            </button>
            <button type="button" disabled={busy !== null} onClick={onCancel} className={GHOST}>
              {C.cancel}
            </button>
          </div>
        ) : null}
        <ErrorLine error={error} />
      </div>
      {asking ? null : (
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <button type="button" disabled={buttons.dismiss.disabled} onClick={onDismiss} className={GHOST}>
            {buttons.dismiss.label}
          </button>
          <Link href={s.editHref} aria-disabled={busy !== null || undefined} className={`${ACT} ${busy !== null ? "pointer-events-none opacity-50" : ""}`}>
            {C.editThenAdd}
          </Link>
          <button type="button" disabled={buttons.add.disabled} onClick={onAdd} className={PRIMARY}>
            {buttons.add.label}
          </button>
        </span>
      )}
    </li>
  );
}

/** One Work row, by its payload. */
export function WorkRow({ item }: { item: ReviewItem & { work: WorkReviewPayload } }) {
  if (item.work.kind === "check") return <WorkCheckRow item={item as Of<"check">} />;
  if (item.work.kind === "ready") return <WorkReadyRow item={item as Of<"ready">} />;
  return <WorkSuggestionRow item={item as Of<"suggestion">} />;
}
