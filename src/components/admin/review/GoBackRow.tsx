"use client";

import { useState } from "react";
import Link from "next/link";
import { History } from "lucide-react";
import type { ReviewItem } from "@/lib/review/summary";
import { GO_BACK_UNDONE, KEPT_DONE, OPEN_WHAT_IT_LEARNED, backToLine } from "@/lib/loops/learnedWords";
import { learnedAction } from "@/components/admin/brand-kit/learnedClient";

/**
 * Review, What YouGrow learned (learning loops step 4, screen 3): a Go back card for a learned image
 * look that did worse than the look before. Go back puts the earlier look back (with Undo on its done
 * line); Keep this look keeps the newer one, and YouGrow only asks again if a later check reads
 * worse. An Undo after Go back leaves a done line with a link to What it learned: the card was
 * answered, so it never comes back. Admins only: the page draws a member the card with Open and a
 * line saying so.
 */

type RowItem = ReviewItem & { goBack: NonNullable<ReviewItem["goBack"]> };
type Busy = "go_back" | "keep" | "undo" | null;
type DoneLine = { text: string; undo: boolean; href?: string };

const GHOST = "rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50";
const ACT = "shrink-0 rounded-md border border-shell-line px-3 py-1.5 text-sm font-medium hover:bg-shell-hover disabled:opacity-50";

export function GoBackRow({ item }: { item: RowItem }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneLine | null>(null);

  async function send(op: "go_back" | "keep") {
    setBusy(op);
    setError(null);
    const r = await learnedAction<{ restored?: number; restoredAt?: string | null }>({ op, target: { cardId: item.goBack.cardId } });
    setBusy(null);
    if (!r.ok) {
      setError(r.data.message ?? (r.data.error === "moved" ? "This look changed since the card was made. Open What it learned to see it." : "Couldn't do that. Try again."));
      return;
    }
    setDone(op === "keep" ? { text: KEPT_DONE, undo: false } : { text: backToLine(r.data.restored ?? item.goBack.to, r.data.restoredAt), undo: true });
  }

  async function undo() {
    setBusy("undo");
    setError(null);
    const r = await learnedAction({ op: "undo", scope: item.goBack.scope });
    setBusy(null);
    if (!r.ok) {
      setError(r.data.message ?? "Couldn't undo. Try again.");
      return;
    }
    setDone({ text: GO_BACK_UNDONE, undo: false, href: item.href });
  }

  return <GoBackRowView item={item} busy={busy} error={error} done={done} onSend={(op) => void send(op)} onUndo={() => void undo()} />;
}

/** The card as drawn for a state: no state of its own. */
export function GoBackRowView({
  item,
  busy,
  error,
  done,
  onSend,
  onUndo,
}: {
  item: RowItem;
  busy: Busy;
  error: string | null;
  done: DoneLine | null;
  onSend: (op: "go_back" | "keep") => void;
  onUndo: () => void;
}) {
  if (done) {
    return (
      <li role="status" className="flex items-center gap-2 px-4 py-1 text-sm text-shell-muted">
        <span>{done.text}</span>
        {done.undo ? (
          <button type="button" disabled={busy !== null} onClick={onUndo} className="font-medium text-shell-ink underline underline-offset-2 disabled:opacity-50">
            Undo
          </button>
        ) : null}
        {done.href ? (
          <Link href={done.href} className="font-medium text-shell-ink underline underline-offset-2">
            {OPEN_WHAT_IT_LEARNED}
          </Link>
        ) : null}
        {error ? <span className="text-red-600 dark:text-red-400">{error}</span> : null}
      </li>
    );
  }
  const lines = item.details?.length ? item.details : [item.detail];
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-shell-line bg-shell-card px-4 py-3">
      <History size={18} className="shrink-0 text-shell-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        {lines.map((line) => (
          <p key={line} className="text-xs text-shell-muted text-pretty">
            {line}
          </p>
        ))}
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      </div>
      <button type="button" disabled={busy !== null} onClick={() => onSend("keep")} className={GHOST}>
        {busy === "keep" ? "Keeping…" : "Keep this look"}
      </button>
      <button type="button" disabled={busy !== null} onClick={() => onSend("go_back")} className={ACT}>
        {busy === "go_back" ? "Going back…" : "Go back"}
      </button>
    </li>
  );
}
