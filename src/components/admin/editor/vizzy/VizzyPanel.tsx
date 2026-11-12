"use client";

import { useState, type ReactNode, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { Sparkles, X } from "lucide-react";
import {
  keepSuggestionsTr,
  undoSuggestionsTr,
  vizzyPending,
  type VizzySuggestion,
} from "@/lib/content/editor/vizzyPlugin";
import type { useVizzyEdit } from "./useVizzyEdit";

/**
 * The Vizzy tab in Edit mode's rail: what is being changed, a box to ask, and each answer with
 * its changes to keep or undo. Changes sit in the text until Save, like typing.
 */

const SELECTION_ASKS = ["Shorter", "Plainer", "More direct", "Fix grammar"];
const WHOLE_ASKS = ["Fix spelling and grammar", "Use UK spelling", "Make it plainer"];

const CARD = "rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950";
const CHIP =
  "rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900";
const SMALL =
  "rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900";
const KEEP = "rounded-md bg-green-800 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700";

type Vizzy = ReturnType<typeof useVizzyEdit>;

export function VizzyMark({ size = 14, className }: { size?: number; className?: string }) {
  return <Sparkles size={size} className={className} aria-hidden />;
}

function Change({ editor, s }: { editor: Editor; s: VizzySuggestion }) {
  return (
    <li className="overflow-hidden rounded-lg border border-neutral-200 text-[13px] leading-5 dark:border-neutral-800">
      {s.beforePlain ? (
        <div className="max-h-28 overflow-y-auto bg-red-50 px-2.5 py-1.5 text-red-900 dark:bg-red-950/40 dark:text-red-200">
          <span className="font-semibold">Before</span>
          <div className="whitespace-pre-wrap line-through">{s.beforePlain}</div>
        </div>
      ) : null}
      <div className="max-h-28 overflow-y-auto bg-green-50 px-2.5 py-1.5 text-green-900 dark:bg-green-950/40 dark:text-green-200">
        <span className="font-semibold">{s.kind === "deletion" ? "Removed" : s.beforePlain ? "After" : "Added"}</span>
        {s.kind === "deletion" ? null : <div className="whitespace-pre-wrap">{s.afterPlain}</div>}
      </div>
      {s.warnings.length ? (
        <ul className="space-y-0.5 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {s.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-1.5 px-2.5 py-1.5">
        <button type="button" className={KEEP} onClick={() => editor.view.dispatch(keepSuggestionsTr(editor.state, [s.id]))}>
          Keep
        </button>
        <button
          type="button"
          className={SMALL}
          onClick={() => {
            const tr = undoSuggestionsTr(editor.state, [s.id]);
            if (tr) editor.view.dispatch(tr);
          }}
        >
          Undo
        </button>
      </div>
    </li>
  );
}

function Turn({ editor, turn }: { editor: Editor; turn: Vizzy["turns"][number] }) {
  const pending = vizzyPending(editor.state).filter((s) => s.group === turn.id);
  const ids = pending.map((s) => s.id);
  return (
    <li className="space-y-2">
      <div className="ml-auto max-w-[90%] rounded-xl rounded-br-sm bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
        <div className="text-xs text-neutral-600 dark:text-neutral-400">{turn.on ? `On: "${turn.on}"` : "On: the whole text"}</div>
        {turn.instruction}
      </div>
      <div className="flex gap-2">
        <span className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-neutral-900 text-white dark:bg-white dark:text-neutral-900">
          <VizzyMark size={12} />
        </span>
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          {turn.reply ? <p className="whitespace-pre-wrap">{turn.reply.trim()}</p> : null}
          {turn.status === "working" && !turn.reply ? <p className="text-neutral-500">Vizzy is working on it…</p> : null}
          {turn.error ? <p className="text-red-700 dark:text-red-400">{turn.error}</p> : null}
          {pending.length ? (
            <ul className="space-y-2">
              {pending.map((s) => (
                <Change key={s.id} editor={editor} s={s} />
              ))}
            </ul>
          ) : null}
          {pending.length > 1 ? (
            <div className="flex gap-1.5">
              <button type="button" className={KEEP} onClick={() => editor.view.dispatch(keepSuggestionsTr(editor.state, ids))}>
                Keep all
              </button>
              <button
                type="button"
                className={SMALL}
                onClick={() => {
                  const tr = undoSuggestionsTr(editor.state, ids);
                  if (tr) editor.view.dispatch(tr);
                }}
              >
                Undo all
              </button>
            </div>
          ) : null}
          {turn.status === "done" && turn.changed > 0 && !pending.length ? (
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              {turn.changed === 1 ? "Change kept or undone." : "All changes kept or undone."}
            </p>
          ) : null}
          {turn.status === "done" && !turn.changed && !turn.error ? (
            <p className="text-xs text-neutral-600 dark:text-neutral-400">Nothing changed.</p>
          ) : null}
          {turn.skipped.length ? (
            <ul className="space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
              {turn.skipped.map((k, i) => (
                <li key={i}>
                  {k.excerpt ? <span className="font-medium">&quot;{k.excerpt}&quot;: </span> : null}
                  {k.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function VizzyPanel({
  editor,
  vizzy,
  rich,
  primaryLabel,
  inputRef,
  footer,
  onAskFocusChange,
}: {
  editor: Editor | null;
  vizzy: Vizzy;
  /** False while the raw text is shown: Vizzy works in Edit mode. */
  rich: boolean;
  primaryLabel: string;
  inputRef: RefObject<HTMLTextAreaElement>;
  /** What Vizzy remembers, when learning is on. */
  footer?: ReactNode;
  /** The ask box took or lost the focus (the bubble over the text hides meanwhile). */
  onAskFocusChange?: (focused: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const { target, busy } = vizzy;
  const send = (text: string) => {
    if (!text.trim() || busy) return;
    void vizzy.ask(text);
    setDraft("");
  };

  if (!rich || !editor) {
    return (
      <section className={CARD}>
        <h2 className="text-sm font-semibold">Ask Vizzy to change the text</h2>
        <p className="mt-1 text-[13px] leading-5 text-neutral-600 dark:text-neutral-400">
          Vizzy works in Edit mode. Switch back to Edit mode to ask.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-3">
      <section className={`${CARD} space-y-3`}>
        <div>
          <h2 className="text-sm font-semibold">Ask Vizzy to change the text</h2>
          <p className="mt-1 text-[13px] leading-5 text-neutral-600 dark:text-neutral-400">
            Select some text and ask, or ask for edits across the whole piece. Nothing saves until you press {primaryLabel}.
          </p>
        </div>

        {vizzy.turns.length ? (
          <ol className="space-y-4">
            {vizzy.turns.map((turn) => (
              <Turn key={turn.id} editor={editor} turn={turn} />
            ))}
          </ol>
        ) : null}

        {vizzy.notice ? (
          <p role="status" className="text-[13px] text-amber-800 dark:text-amber-300">
            {vizzy.notice}
          </p>
        ) : null}

        <div className="space-y-2 rounded-lg border border-neutral-300 p-2.5 dark:border-neutral-700">
          {target ? (
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs leading-[18px] text-blue-900 dark:border-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
              <span className="min-w-0 flex-1">
                <strong>Changing:</strong> &quot;{target.plain.length > 90 ? `${target.plain.slice(0, 87)}...` : target.plain}&quot;
              </span>
              <button type="button" aria-label="Stop changing this text" onClick={vizzy.clearTarget} className="text-blue-900 dark:text-blue-200">
                <X size={14} aria-hidden />
              </button>
            </div>
          ) : (
            <p className="text-xs text-neutral-600 dark:text-neutral-400">Nothing selected, so Vizzy edits across the whole piece.</p>
          )}
          <label className="block">
            <span className="sr-only">Ask Vizzy for a change</span>
            <textarea
              ref={inputRef}
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => {
                if (!target) vizzy.captureTarget();
                onAskFocusChange?.(true);
              }}
              onBlur={() => onAskFocusChange?.(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  // Escape here clears the ask; it doesn't close Edit mode.
                  e.preventDefault();
                  e.stopPropagation();
                  if (busy) vizzy.stop();
                  else if (draft) setDraft("");
                  else vizzy.clearTarget();
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              placeholder={target ? "Ask for a change, like: make this shorter" : "Ask for edits across the piece, like: use UK spelling"}
              className="w-full resize-none bg-transparent text-sm leading-5 outline-none"
            />
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {(target ? SELECTION_ASKS : WHOLE_ASKS).map((a) => (
              <button key={a} type="button" className={CHIP} disabled={busy} onClick={() => send(a)}>
                {a}
              </button>
            ))}
            <span className="flex-1" />
            {busy ? (
              <button type="button" className={SMALL} onClick={vizzy.stop}>
                Stop
              </button>
            ) : (
              <button
                type="button"
                disabled={!draft.trim()}
                onClick={() => send(draft)}
                className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-semibold text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Ask
              </button>
            )}
          </div>
        </div>
      </section>
      {footer}
    </div>
  );
}
