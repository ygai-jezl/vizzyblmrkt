"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { inputClass } from "@/components/admin/connect/ui";
import type { Opened } from "@/lib/work/quickEdit";
import { WORK_COPY } from "@/lib/work/screenWords";
import { useRowEditor } from "./rowEditors";
import { SIDE_LABEL } from "./TaskSections";

/**
 * Click to edit, in the open row on Work's list (WORK_QUICK_EDIT_ENABLED): the title, the
 * description and the notes.
 * - The title saves on Enter or a click elsewhere on the page; Esc puts back the old title; an
 *   empty title isn't saved.
 * - The description and notes take Enter as a new line, and save on a click elsewhere or Cmd+Enter
 *   (Ctrl+Enter on Windows); Esc puts back what was there, with Undo.
 * - Switching to another app doesn't count as a click elsewhere, so half typed text doesn't save
 *   while something is copied in. Enter never cuts off text typed with an input method.
 * - A click on a Copy button or a link inside the text, or while selecting text, doesn't start
 *   editing.
 * - Text a refusal sent back (`kept`) reopens the box with it, so nothing typed is lost.
 */

type Common = {
  field: "title" | "description" | "notes";
  value: string;
  maxLength: number;
  /** When it opened: the row's line sends with that stamp. */
  opened: () => Opened;
  onSave: (text: string, opened: Opened | null) => void;
  /** Text a refusal kept for this box, and how to say it was taken back. */
  kept?: string;
  onKept: () => void;
  error?: string;
};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Where a click lands that shouldn't start editing: a button or a link inside, or a selection being made. */
function leaveAlone(e: MouseEvent): boolean {
  if ((e.target as HTMLElement).closest("button, a")) return true;
  return (typeof window !== "undefined" && (window.getSelection()?.toString() ?? "").length > 0) || false;
}

function useInline({ field, value, opened, onSave, kept, onKept }: Common, label: string) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [from, setFrom] = useState<Opened | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const box = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // What opened the box gets focus back after Enter, Cmd+Enter or Esc; a click elsewhere keeps its own.
  const opener = useRef<HTMLButtonElement>(null);
  // Open now: a blur after Enter or Esc closed it does nothing more.
  const live = useRef(false);
  const back = useRef(false);
  const start = (text = value, at: Opened | null = opened()) => {
    setDraft(text);
    setFrom(at);
    setUndo(null);
    live.current = true;
    setEditing(true);
  };
  const commit = (byKey = false) => {
    if (!live.current) return;
    live.current = false;
    back.current = byKey;
    setEditing(false);
    const next = field === "title" ? draft.trim() : draft;
    if (field === "title" && !next) return;
    if (next !== value) onSave(draft, from);
  };
  const cancel = (byKey = false) => {
    if (!live.current) return;
    live.current = false;
    back.current = byKey;
    setEditing(false);
    if (field !== "title" && draft !== value) setUndo(draft);
  };
  useEffect(() => {
    if (editing || !back.current) return;
    back.current = false;
    opener.current?.focus();
  }, [editing]);
  // A refused change's text comes back to its box, to save again on the task as it is now.
  useEffect(() => {
    if (kept === undefined) return;
    start(kept, null);
    onKept();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kept]);
  useEffect(() => {
    if (!editing) return;
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  useRowEditor(`text:${field}`, editing ? { label, dirty: draft !== value, close: () => cancel(), commit: () => commit() } : null);
  const onBlur = () => {
    // Switching to another app isn't clicking elsewhere: the box stays open, and keeps its text.
    if (typeof document !== "undefined" && !document.hasFocus()) return;
    commit();
  };
  return { editing, draft, setDraft, start, commit, cancel, undo, setUndo, box, opener, onBlur };
}

/** The title, in the open row's heading: click it to rename. */
export function InlineTitle(props: Common & { headingId: string; taskRef: number; chips: ReactNode }) {
  const s = useInline(props, "Title");
  const hint = `wk-row-${props.field}-hint`;
  if (s.editing) {
    return (
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Task #{props.taskRef}</p>
        <input
          ref={s.box}
          type="text"
          aria-label="Title"
          aria-describedby={hint}
          maxLength={props.maxLength}
          value={s.draft}
          onChange={(e) => s.setDraft(e.target.value)}
          onBlur={s.onBlur}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              s.commit(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              s.cancel(true);
            }
          }}
          className={`${inputClass} text-lg font-semibold`}
        />
        <p id={hint} className="text-xs text-neutral-500 dark:text-neutral-400">
          <kbd className="rounded border border-neutral-300 px-1 font-sans dark:border-neutral-700">Enter</kbd> to save, <kbd className="rounded border border-neutral-300 px-1 font-sans dark:border-neutral-700">Esc</kbd> to cancel
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p aria-hidden className="text-xs uppercase tracking-wide text-neutral-400">
        Task #{props.taskRef}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={props.headingId} tabIndex={-1} className="text-lg font-semibold outline-none" data-qe="heading">
          <span className="sr-only">Task #{props.taskRef} </span>
          <button ref={s.opener} type="button" title={WORK_COPY.clickToRename} aria-describedby={`${hint}-r`} onClick={() => s.start()} className="cursor-text text-left hover:underline hover:decoration-dotted hover:underline-offset-4">
            {props.value}
          </button>
          <span id={`${hint}-r`} className="sr-only">
            {WORK_COPY.clickToRename}
          </span>
        </h2>
        {props.chips}
      </div>
      {props.error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/** The description or the notes: click the text, or Edit, to change it. */
export function InlineArea(props: Common & { label: string; rows: number; empty: string; render: (text: string) => ReactNode }) {
  const s = useInline(props, props.label);
  const hint = `wk-row-${props.field}-hint`;
  const mac = isMac();
  const kbd = "rounded border border-neutral-300 px-1 font-sans dark:border-neutral-700";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        {s.editing ? (
          <label htmlFor={`wk-row-${props.field}`} className={SIDE_LABEL}>
            {props.label}
          </label>
        ) : (
          <p className={SIDE_LABEL}>{props.label}</p>
        )}
        {!s.editing ? (
          <button ref={s.opener} type="button" onClick={() => s.start()} className="text-xs text-neutral-500 underline underline-offset-4" aria-label={`Edit ${props.label.toLowerCase()}`}>
            Edit
          </button>
        ) : null}
      </div>
      {s.editing ? (
        <>
          <textarea
            ref={s.box}
            id={`wk-row-${props.field}`}
            rows={props.rows}
            maxLength={props.maxLength}
            aria-describedby={hint}
            value={s.draft}
            onChange={(e) => s.setDraft(e.target.value)}
            onBlur={s.onBlur}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                s.commit(true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                s.cancel(true);
              }
            }}
            className={inputClass}
          />
          <p id={hint} className="text-xs text-neutral-500 dark:text-neutral-400">
            <kbd className={kbd}>{mac ? "⌘" : "Ctrl"}</kbd> <kbd className={kbd}>Enter</kbd> or click elsewhere to save, <kbd className={kbd}>Esc</kbd> to put back what was there
          </p>
        </>
      ) : (
        // A click on the text edits it; the Edit button above is the keyboard's way in.
        <div onClick={(e) => (leaveAlone(e) ? undefined : s.start())} className="cursor-text">
          {props.value ? props.render(props.value) : <p className="text-sm text-neutral-400">{props.empty}</p>}
        </div>
      )}
      {s.undo !== null && !s.editing ? (
        <p role="status" className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          {WORK_COPY.putBack}
          <button type="button" onClick={() => s.start(s.undo ?? props.value)} className="underline underline-offset-4">
            {WORK_COPY.undo}
          </button>
        </p>
      ) : null}
      {props.error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
