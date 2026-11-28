"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PASTE_MESSAGES, PASTE_WORDS, addWords, fromReview, timelineDetail } from "@/lib/crm/paste/words";
import { PUBLIC_LIST } from "@/lib/crm/paste/publicLists";
import { Modal } from "../email/Modal";
import { Banner, Button, inputClass } from "../connect/ui";
import { PublicListCard } from "./PublicListCard";
import {
  addedLines,
  addList,
  boxMessage,
  checkBox,
  columnChip,
  dismissList,
  kindWord,
  noteLines,
  notAdded,
  openList,
  pasteError,
  readList,
  skippedLines,
  viewSummary,
  type AddAnswer,
  type PasteBatchView,
  type Skipped,
} from "./pasteApi";

/**
 * Paste a list (RAISE_PASTE_ENABLED), for admins on People: paste rows from a sheet with the
 * header row first, say where the list is from, and read it. The app's own code reads the rows
 * (no AI): a row with an email or a phone is a person, a row with only a firm's web address a
 * company, and every other row is left out with its reason. What will be added waits as one card
 * in Review for 7 days; Add adds everyone on it at Not yet for marketing emails.
 *
 * With `batchId` (Review's link or Vizzy's card, ?paste=) it opens on that waiting list, where the
 * rows left out aren't kept, so it says only how many there were. `openPublicList` opens Start
 * from a public list, as a board with no investors yet does. `onAdded` runs once people were
 * added, when the sheet closes, so the lists behind it reload.
 */

type Phase = "box" | "reading" | "loading" | "preview" | "nothing" | "adding" | "done";

const label = "text-xs font-medium text-neutral-600 dark:text-neutral-400";
const hint = "block text-xs text-neutral-500";
const chip = "rounded border border-neutral-200 px-1.5 py-0.5 text-xs dark:border-neutral-800";

export function PasteListSheet({
  open,
  onClose,
  onAdded,
  batchId = null,
  openPublicList = false,
}: {
  open: boolean;
  onClose: () => void;
  onAdded?: () => void;
  /** A waiting list to open on, by its id (?paste=). */
  batchId?: string | null;
  /** Open Start from a public list under the box. */
  openPublicList?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>(batchId ? "loading" : "box");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [view, setView] = useState<PasteBatchView | null>(null);
  /** The rows left out, by number and reason: only right after reading, never from Review. */
  const [skipped, setSkipped] = useState<Skipped[] | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<AddAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const added = useRef(false);

  useEffect(() => {
    if (!open || !batchId) return;
    let live = true;
    setPhase("loading");
    void openList(batchId).then((r) => {
      if (!live) return;
      if (!r.ok || !r.data.batch) {
        setError(pasteError(r));
        return setPhase("box");
      }
      setView(r.data.batch);
      setSkipped(null);
      setWarning(r.data.warning ?? null);
      setPhase("preview");
    });
    return () => {
      live = false;
    };
  }, [open, batchId]);

  const startAgain = () => {
    setPhase("box");
    setText("");
    setView(null);
    setSkipped(null);
    setWarning(null);
    setResult(null);
    setError(null);
  };

  const close = () => {
    if (added.current) onAdded?.();
    added.current = false;
    startAgain();
    setSource("");
    onClose();
  };

  async function read(e: FormEvent) {
    e.preventDefault();
    const problem = checkBox(text, source);
    if (problem) return setError(boxMessage(problem));
    setError(null);
    setPhase("reading");
    const r = await readList(text, source);
    if (r.ok && r.data.batch) {
      setView(r.data.batch);
      setSkipped(r.data.skipped ?? []);
      setWarning(r.data.warning ?? null);
      // The rows are on the card now: the box doesn't hold on to them.
      setText("");
      return setPhase("preview");
    }
    if (r.ok && r.data.error === "nothing_to_add") {
      setSkipped(r.data.skipped ?? []);
      return setPhase("nothing");
    }
    setError(pasteError(r));
    setPhase("box");
  }

  async function add() {
    if (!view) return;
    setError(null);
    setPhase("adding");
    const r = await addList(view.id, view.rev);
    if (r.ok && r.data.added) {
      added.current = true;
      setResult(r.data);
      return setPhase("done");
    }
    setError(pasteError(r));
    if (r.data?.error === "paste_gone") {
      setView(null);
      return setPhase("box");
    }
    setPhase("preview");
  }

  async function dismiss() {
    if (!view) return;
    setError(null);
    setDismissing(true);
    const r = await dismissList(view.id, view.rev);
    setDismissing(false);
    if (r.ok) return close();
    setError(pasteError(r));
    if (r.data?.error === "paste_gone") {
      setView(null);
      setPhase("box");
    }
  }

  const busy = phase === "reading" || phase === "adding" || dismissing;

  return (
    <Modal open={open} onClose={close} title={PASTE_WORDS.title} wide>
      <div className="space-y-4 text-sm">
        {error ? <Banner tone="err">{error}</Banner> : null}
        {phase === "loading" ? (
          <p className="text-neutral-500">Loading…</p>
        ) : phase === "box" || phase === "reading" ? (
          <form onSubmit={(e) => void read(e)} className="space-y-4" aria-label={PASTE_WORDS.title} noValidate>
            <div className="space-y-1">
              <p>{PASTE_WORDS.lead}</p>
              <p className="text-neutral-500">{PASTE_WORDS.anyList}</p>
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="paste-rows">
                {PASTE_WORDS.rowsLabel}
              </label>
              <textarea
                id="paste-rows"
                rows={10}
                maxLength={200_000}
                spellCheck={false}
                autoComplete="off"
                placeholder={PASTE_WORDS.rowsPlaceholder}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className={`${inputClass} font-mono text-xs`}
              />
              <span className={hint}>{PASTE_WORDS.rowsHint}</span>
            </div>
            <div className="space-y-1">
              <label className={label} htmlFor="paste-source">
                {PASTE_WORDS.sourceLabel}
              </label>
              <input
                id="paste-source"
                type="text"
                required
                maxLength={80}
                autoComplete="off"
                placeholder={PASTE_WORDS.sourcePlaceholder}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className={inputClass}
              />
              <span className={hint}>{PASTE_WORDS.sourceHint}</span>
            </div>
            <div>
              <Button type="submit" tone="primary" disabled={busy}>
                {phase === "reading" ? PASTE_WORDS.reading : PASTE_WORDS.read}
              </Button>
            </div>
            <details open={openPublicList} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <summary className="cursor-pointer font-medium">{PUBLIC_LIST.summary}</summary>
              <div className="mt-3">
                <PublicListCard heading={false} />
              </div>
            </details>
          </form>
        ) : phase === "nothing" ? (
          <div className="space-y-3">
            <Banner tone="info">{PASTE_MESSAGES.nothing_to_add}</Banner>
            <SkippedList skipped={skipped ?? []} />
            <Button onClick={startAgain}>{PASTE_WORDS.pasteAgain}</Button>
          </div>
        ) : phase === "done" && result ? (
          <PasteDone result={result} onDone={close} />
        ) : view ? (
          <PastePreview view={view} skipped={skipped} warning={warning} busy={busy} adding={phase === "adding"} onAdd={() => void add()} onDismiss={() => void dismiss()} />
        ) : null}
      </div>
    </Modal>
  );
}

function SkippedList({ skipped }: { skipped: readonly Skipped[] }) {
  if (!skipped.length) return null;
  return (
    <ul className="space-y-0.5 text-xs text-neutral-600 dark:text-neutral-400">
      {skippedLines(skipped).map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * A read list before it is added: how each column was read, each row it adds and as what, the rows
 * left out by number and why (or, opened from Review, how many there were), its notes and the
 * plan's people warning. Exported for its test.
 */
export function PastePreview({
  view,
  skipped,
  warning,
  busy,
  adding = false,
  onAdd,
  onDismiss,
}: {
  view: PasteBatchView;
  /** Null when opened from Review, where the rows left out aren't kept. */
  skipped: readonly Skipped[] | null;
  warning: string | null;
  busy: boolean;
  /** Add was pressed and hasn't answered yet. */
  adding?: boolean;
  onAdd: () => void;
  onDismiss: () => void;
}) {
  const left = notAdded(view);
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="font-medium">{viewSummary(view)}</p>
        <p className="text-xs text-neutral-500">{timelineDetail(null, view.source)}</p>
      </div>
      {view.columns.read.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={label}>{PASTE_WORDS.columnsRead}</span>
          {view.columns.read.map((c) => (
            <span key={`${c.header}:${c.as}`} className={chip}>
              {columnChip(c)}
            </span>
          ))}
        </div>
      ) : null}
      {view.columns.left.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={label}>{PASTE_WORDS.columnsLeft}</span>
          {view.columns.left.map((h) => (
            <span key={h} className={`${chip} text-neutral-500 line-through`}>
              {h}
            </span>
          ))}
        </div>
      ) : null}
      <div className="max-h-80 overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 border-b border-neutral-200 bg-white text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950">
            <tr>
              <th className="px-3 py-2 font-medium">{PASTE_WORDS.tableRow}</th>
              <th className="px-3 py-2 font-medium">{PASTE_WORDS.tableAdds}</th>
              <th className="px-3 py-2 font-medium">{PASTE_WORDS.tableName}</th>
              <th className="px-3 py-2 font-medium">{PASTE_WORDS.tableContact}</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.row} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                <td className="px-3 py-1.5 tabular-nums text-neutral-500">{r.row}</td>
                <td className="px-3 py-1.5">{kindWord(r.kind)}</td>
                <td className="px-3 py-1.5">{r.name ?? ""}</td>
                <td className="break-all px-3 py-1.5 text-neutral-600 dark:text-neutral-400">{r.contact}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {skipped ? <SkippedList skipped={skipped} /> : left ? <p className="text-xs text-neutral-600 dark:text-neutral-400">{fromReview(left)}</p> : null}
      {noteLines(view).map((n) => (
        <p key={n} className="text-xs text-neutral-500">
          {n}
        </p>
      ))}
      {warning ? <Banner tone="info">{warning}</Banner> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="primary" disabled={busy} onClick={onAdd}>
          {adding ? PASTE_WORDS.adding : addWords(view.counts)}
        </Button>
        <Button disabled={busy} onClick={onDismiss}>
          {PASTE_WORDS.dismiss}
        </Button>
        <span className="text-xs text-neutral-500">{PASTE_WORDS.waits}</span>
      </div>
    </div>
  );
}

/** After the add: who was added and who was already here. Exported for its test. */
export function PasteDone({ result, onDone }: { result: Pick<AddAnswer, "added" | "already" | "fieldsNotSaved">; onDone: () => void }) {
  const [first, ...rest] = addedLines(result);
  return (
    <div className="space-y-3">
      <Banner tone="ok">{first}</Banner>
      {rest.map((line) => (
        <p key={line} className="text-xs text-neutral-600 dark:text-neutral-400">
          {line}
        </p>
      ))}
      <Button tone="primary" onClick={onDone}>
        {PASTE_WORDS.done}
      </Button>
    </div>
  );
}
