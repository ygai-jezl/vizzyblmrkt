"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ExternalLink, Info, Loader2, X } from "lucide-react";
import { Button } from "@/components/admin/connect/ui";
import { Chip } from "@/components/admin/people/Chip";
import type { WorkRow } from "@/lib/work/list";
import { escapeStep, leaveStep, type Opened } from "@/lib/work/quickEdit";
import { closeTaskLabel, regionsDownText, unsavedLine, WORK_COPY } from "@/lib/work/screenWords";
import type { TaskScreen } from "@/lib/work/screens";
import type { WorkTaskPage } from "@/lib/work/service";
import { WORK_LIMITS } from "@/lib/work/types";
import { workCall, workErrorText } from "./api";
import { Decisions } from "./Decisions";
import { InlineArea, InlineTitle } from "./InlineText";
import { RowEditorsContext, type RowEditor, type RowEditors } from "./rowEditors";
import {
  BlockedByField,
  BrandField,
  CheckField,
  DescriptionText,
  DueCheckBanner,
  HistorySection,
  IdeaField,
  LinksSection,
  MeasureCard,
  MustHaveField,
  OriginLine,
  RegionsDownNote,
  StageField,
  StatusField,
  TaskChips,
  taskBits,
  VizzySuggested,
  WaitingBanner,
} from "./TaskSections";
import { useRowQueue } from "./useRowQueue";

/**
 * The open row on Work's list (WORK_QUICK_EDIT_ENABLED): everything the task's page has, under
 * the task's row. Its heading (click the title to rename it), Open the full page and Close, one
 * status line, the quick fields in the columns' order (Status, Stage, Brand, Idea, Blocked by,
 * Check, Must have), then the description and notes, How we'll know it worked, links, decisions,
 * the newest 5 of History and Delete. Changes go through the row's line (useRowQueue). Closing,
 * opening another row, a filter, Open the full page and Make it an idea all wait for its saves,
 * and an editor holding unsaved input asks first. Esc closes the innermost thing first.
 */

/** What the list asks of the open row: to leave once its saves are in, asking first about unsaved input. */
export interface PanelApi {
  leave(then: () => void): void;
}

/** A field to move focus to when the row opens, from the cell clicked (src/lib/work/quickEdit.ts cellFocus). */
export interface FocusWant {
  mark: string;
  start?: "block" | "check";
  n: number;
}

const modified = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;

/** The section's columns: side by side once the list is 900px wide, stacked below. */
function bandCols(width: number): string {
  if (width >= 900) return "grid-cols-4";
  if (width >= 520) return "grid-cols-2";
  return "grid-cols-1";
}

export function TaskRowPanel({
  screen,
  kept,
  panelId,
  width,
  want,
  onClose,
  onGoto,
  onDeleted,
  bind,
}: {
  screen: TaskScreen;
  kept: boolean;
  panelId: string;
  width: number;
  want: FocusWant | null;
  onClose: () => void;
  onGoto: (ref: number) => void;
  onDeleted: (ref: number, title: string) => void;
  bind: (api: PanelApi | null) => void;
}) {
  const router = useRouter();
  const ref = screen.page.task.ref;
  const q = useRowQueue(ref, screen.page);
  const qRef = useRef(q);
  qRef.current = q;
  const task = q.shown;
  const page: WorkTaskPage = { ...screen.page, ...q.view, task };
  const { lastMove, open, waitingOn } = taskBits(screen, task, page);
  const headingId = `${panelId}-h`;
  const root = useRef<HTMLElement>(null);
  const lastInside = useRef<HTMLElement | null>(null);

  // The editors open in this row, in the order they opened, and the stamp each opened on.
  const editors = useRef(new Map<string, RowEditor>());
  const openedAt = useRef(new Map<string, Opened | null>());
  const registry = useMemo<RowEditors>(
    () => ({
      set(id, e) {
        if (e) {
          // Move its date keeps the check it opened on; every other editor the task's stamp.
          if (!editors.current.has(id)) openedAt.current.set(id, id === "check-move" ? qRef.current.tapped() : qRef.current.opened());
          editors.current.set(id, e);
        } else {
          editors.current.delete(id);
          openedAt.current.delete(id);
        }
      },
    }),
    [],
  );

  const [prompt, setPrompt] = useState<{ label: string; then: (() => void) | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [startBlock, setStartBlock] = useState(0);
  const [startCheck, setStartCheck] = useState(0);
  // Buttons that take focus: each sits in a span, since Button passes no ref.
  const keepRef = useRef<HTMLSpanElement>(null);
  const deleteRef = useRef<HTMLSpanElement>(null);
  const confirmRef = useRef<HTMLSpanElement>(null);
  const focusIn = (r: { current: HTMLElement | null }) => r.current?.querySelector("button")?.focus();

  const waitThen = (then: () => void) =>
    void (async () => {
      if (await qRef.current.idle()) then();
    })();

  const states = () => [...editors.current.values()].map((e) => ({ label: e.label, dirty: e.dirty, text: !!e.commit }));

  /** Leave the row once its saves are in: text boxes save what they hold, and an editor with unsaved input asks first. */
  const leave = (then: () => void) => {
    const open = [...editors.current.values()];
    const step = leaveStep(states());
    for (const i of step.save) open[i]?.commit?.();
    if (step.ask !== null) return setPrompt({ label: step.ask, then });
    waitThen(then);
  };

  const keepEditing = () => {
    setPrompt(null);
    const back = lastInside.current;
    if (back && root.current?.contains(back)) back.focus();
  };
  const discard = () => {
    const then = prompt?.then ?? null;
    for (const e of [...editors.current.values()]) if (!e.commit && e.dirty) e.close();
    setPrompt(null);
    if (then) waitThen(then);
  };

  useEffect(() => {
    bind({ leave });
  });
  useEffect(() => () => bind(null), [bind]);
  useEffect(() => {
    if (prompt) focusIn(keepRef);
  }, [prompt]);
  useEffect(() => {
    if (confirmDelete) focusIn(confirmRef);
  }, [confirmDelete]);

  // Leaving the page asks through the browser too, while a save waits or an editor holds input.
  useEffect(() => {
    const ask = (e: BeforeUnloadEvent) => {
      const dirty = qRef.current.busy || [...editors.current.values()].some((ed) => ed.dirty);
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, []);

  // Focus on the field of the cell clicked: never a text box, unless an editor opens there.
  useEffect(() => {
    if (!want) return;
    const el = root.current;
    if (!el) return;
    if (want.start === "block") {
      setStartBlock((n) => n + 1);
      requestAnimationFrame(() => el.querySelector<HTMLElement>("#wk-t-block")?.focus());
      return;
    }
    if (want.start === "check") {
      setStartCheck((n) => n + 1);
      return;
    }
    let target: HTMLElement | null = null;
    if (want.mark === "check-due") target = el.querySelector<HTMLElement>('[data-qe="check-due"] button');
    else if (want.mark === "vizzy") {
      const box = el.querySelector<HTMLDetailsElement>('[data-qe="vizzy-box"]');
      if (box) box.open = true;
      target = el.querySelector<HTMLElement>('[data-qe="vizzy"]');
    } else target = el.querySelector<HTMLElement>(`[data-qe="${want.mark}"]`);
    target = target ?? el.querySelector<HTMLElement>('[data-qe="heading"]');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    // Only a new click moves focus: the row draws again on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want?.n]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    const open = [...editors.current.values()];
    const step = escapeStep({ asking: prompt !== null, confirmingDelete: confirmDelete, editors: states() });
    if (step.kind === "keep") return keepEditing();
    if (step.kind === "cancel_delete") {
      setConfirmDelete(false);
      focusIn(deleteRef);
      return;
    }
    if (step.kind === "ask") return setPrompt({ label: open[step.at]!.label, then: null });
    if (step.kind === "close_editor") return open[step.at]!.close();
    onClose();
  };

  const goto = (e: MouseEvent<HTMLAnchorElement>, to: number) => {
    if (modified(e)) return;
    e.preventDefault();
    onGoto(to);
  };
  const away = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (modified(e)) return;
    e.preventDefault();
    leave(() => router.push(href));
  };
  const saveEditor = async (id: "check" | "blockedBy" | "measure", body: Parameters<typeof q.editor>[1]) => {
    const ok = await qRef.current.editor(id, body, openedAt.current.get(id) ?? null);
    // Refused: saving again builds on the task as the row reads it now.
    if (!ok) openedAt.current.set(id, null);
    return ok;
  };
  // Delete waits for the row's saves, and goes once however often it is pressed.
  const deleting = useRef(false);
  const remove = () => {
    if (deleting.current) return;
    deleting.current = true;
    void (async () => {
      const ready = await qRef.current.idle();
      if (!ready) {
        deleting.current = false;
        return;
      }
      setDeleteError(null);
      const r = await workCall(`/tasks/${ref}`, "DELETE");
      deleting.current = false;
      if (!r.ok) {
        setConfirmDelete(false);
        return setDeleteError(workErrorText(r.data));
      }
      onDeleted(ref, task.title);
    })();
  };

  const err = (field: keyof typeof q.errors) =>
    q.errors[field] ? (
      <p role="alert" className="text-xs text-red-700 dark:text-red-400">
        {q.errors[field]}
      </p>
    ) : null;
  const wide = width >= 900;
  const cols = bandCols(width);

  const description = (
    <InlineArea
      field="description"
      label="Description"
      rows={4}
      maxLength={WORK_LIMITS.description}
      value={task.description}
      empty={WORK_COPY.noDescription}
      render={(t) => <DescriptionText text={t} />}
      opened={q.opened}
      onSave={(t, at) => q.text("description", t, at)}
      kept={q.kept.description}
      onKept={() => q.clearKept("description")}
      error={q.errors.description}
    />
  );
  const notes = (
    <InlineArea
      field="notes"
      label="Notes"
      rows={3}
      maxLength={WORK_LIMITS.notes}
      value={task.notes}
      empty={WORK_COPY.noNotes}
      render={(t) => <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">{t}</p>}
      opened={q.opened}
      onSave={(t, at) => q.text("notes", t, at)}
      kept={q.kept.notes}
      onKept={() => q.clearKept("notes")}
      error={q.errors.notes}
    />
  );
  const measure = (
    <div className="space-y-1">
      <MeasureCard screen={screen} task={task} page={page} busy={false} onSave={(m) => saveEditor("measure", { measure: m })} />
      {err("measure")}
    </div>
  );
  const links = (
    <div className="space-y-1">
      <LinksSection screen={screen} task={task} page={page} onTyped={(next) => q.links("typedLinks", task.typedLinks, next)} onFree={(next) => q.links("links", task.links, next)} />
      {err("typedLinks")}
      {err("links")}
    </div>
  );
  const decisions = <Decisions taskRef={ref} decisions={page.decisions} typedLinks={task.typedLinks} me={screen.me} names={page.names} timeZone={page.timeZone} today={screen.today} drafted={null} />;
  const history = <HistorySection screen={screen} task={task} page={page} limit={5} />;
  const del = page.can.delete ? (
    <div className="space-y-1">
      {confirmDelete ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <span className="flex-1">{WORK_COPY.deleteConfirm}</span>
          <span ref={confirmRef}>
            <Button tone="danger" onClick={remove}>
              Delete
            </Button>
          </span>
          <Button
            onClick={() => {
              setConfirmDelete(false);
              focusIn(deleteRef);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <span ref={deleteRef}>
            <Button tone="danger" onClick={() => setConfirmDelete(true)}>
              Delete task
            </Button>
          </span>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{WORK_COPY.adminsOnly}</p>
        </>
      )}
      {deleteError ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {deleteError}
        </p>
      ) : null}
    </div>
  ) : null;

  return (
    <RowEditorsContext.Provider value={registry}>
      <section
        ref={root}
        id={panelId}
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        onFocusCapture={(e) => {
          const t = e.target as HTMLElement;
          if (t.matches("input, textarea, select")) lastInside.current = t;
        }}
        className="space-y-4 bg-white p-4 dark:bg-neutral-950"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <InlineTitle
              field="title"
              taskRef={ref}
              headingId={headingId}
              maxLength={WORK_LIMITS.title}
              value={task.title}
              chips={<TaskChips task={task} waitingOn={waitingOn} ideaWords={screen.ideaWords} />}
              opened={q.opened}
              onSave={(t, at) => q.text("title", t, at)}
              kept={q.kept.title}
              onKept={() => q.clearKept("title")}
              error={q.errors.title}
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link
              href={`/admin/work/${ref}`}
              onClick={(e) => away(e, `/admin/work/${ref}`)}
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              <ExternalLink size={14} aria-hidden />
              {WORK_COPY.openFull}
            </Link>
            <Button aria-label={closeTaskLabel(ref)} title={WORK_COPY.closeRowHint} onClick={onClose}>
              <X size={14} aria-hidden />
              {WORK_COPY.closeRow}
              <kbd className="rounded border border-neutral-300 px-1 text-[11px] font-normal text-neutral-500 dark:border-neutral-700">Esc</kbd>
            </Button>
          </div>
        </div>
        <RowStatusLine status={q.status} />
        <OriginLine screen={screen} task={task} page={page} />
        <VizzySuggested screen={screen} />
        {kept ? (
          <p role="note" className="flex items-start gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
            <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
            {WORK_COPY.keptNote}
          </p>
        ) : null}
        {prompt ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <span className="flex-1">{unsavedLine(prompt.label)}</span>
            <span ref={keepRef}>
              <Button onClick={keepEditing}>{WORK_COPY.keepEditing}</Button>
            </span>
            <Button onClick={discard}>{WORK_COPY.discard}</Button>
          </div>
        ) : null}
        <RegionsDownNote page={page} />
        {page.due && task.check ? (
          <div data-qe="check-due">
            <DueCheckBanner screen={screen} task={task} page={page} via="work_list" send={(tap) => qRef.current.check(tap)} onStart={() => {}} onSaid={() => {}} />
          </div>
        ) : null}
        <WaitingBanner waitingOn={waitingOn} open={open} onGoto={goto} />

        <div role="group" aria-label="Quick fields" className={`grid ${cols} gap-4 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800`}>
          <div className={cols === "grid-cols-1" ? "" : "col-span-2"}>
            <StatusField screen={screen} page={page} status={task.status} lastMove={lastMove} disabled={false} onPick={(s) => q.pick("status", s)} />
            {err("status")}
          </div>
          <div>
            <StageField value={task.stage} disabled={false} onChange={(stage) => q.later("stage", stage)} />
            {err("stage")}
          </div>
          {screen.multiBrand ? (
            <div>
              <BrandField screen={screen} page={page} value={task.brandId} disabled={false} onChange={(brandId) => q.later("brandId", brandId)} />
              {err("brandId")}
            </div>
          ) : null}
          <IdeaField screen={screen} task={task} page={page} onAway={away} />
          <div>
            <BlockedByField screen={screen} page={page} busy={false} onSave={(blockedBy) => saveEditor("blockedBy", { blockedBy })} onGoto={goto} start={startBlock} />
            {err("blockedBy")}
          </div>
          <div>
            <CheckField
              screen={screen}
              task={task}
              page={page}
              busy={false}
              onSave={(check) => saveEditor("check", { check })}
              onMoved={() => {}}
              send={async (tap) => {
                const a = await qRef.current.check(tap, openedAt.current.get("check-move") ?? null);
                if (!a.ok) openedAt.current.set("check-move", null);
                return a;
              }}
              via="work_list"
              start={startCheck}
            />
            {err("check")}
          </div>
          <div>
            <MustHaveField value={task.mustHave} disabled={false} onChange={(v) => q.pick("mustHave", v)} />
            {err("mustHave")}
          </div>
        </div>

        {wide ? (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
            <div className="min-w-0 space-y-5">
              {description}
              {notes}
              {links}
              {decisions}
            </div>
            <div className="min-w-0 space-y-5">
              {measure}
              {history}
              {del}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {description}
            {notes}
            {measure}
            {links}
            {decisions}
            {history}
            {del}
          </div>
        )}
      </section>
    </RowEditorsContext.Provider>
  );
}

/** The open row's one status line: always there, so Saved is read out politely; a refusal at once. */
function RowStatusLine({ status }: { status: ReturnType<typeof useRowQueue>["status"] }) {
  return (
    <div className="min-h-5 text-sm">
      <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
        {status.kind === "saving" ? (
          <>
            <Loader2 size={14} aria-hidden className="animate-spin" />
            {WORK_COPY.saving}
          </>
        ) : status.kind === "saved" ? (
          <>
            <Check size={14} aria-hidden className="text-green-600" />
            {status.line}
          </>
        ) : null}
      </p>
      {status.kind === "error" ? (
        <p role="alert" className="flex items-start gap-1.5 text-red-700 dark:text-red-400">
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          {status.line}
        </p>
      ) : null}
    </div>
  );
}

/** The row while the task is on its way: its own line's values, and Opening…; the fields become changeable when it arrives. */
export function PendingRowPanel({ row, taskRef, panelId, onClose, focus }: { row: WorkRow | null; taskRef?: number; panelId: string; onClose: () => void; focus: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const ref = row?.ref ?? taskRef ?? 0;
  useEffect(() => {
    if (focus) heading.current?.focus({ preventScroll: true });
  }, [focus]);
  return (
    <section
      id={panelId}
      aria-labelledby={`${panelId}-h`}
      aria-busy="true"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      className="space-y-4 bg-white p-4 dark:bg-neutral-950"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p aria-hidden className="text-xs uppercase tracking-wide text-neutral-400">
            Task #{ref}
          </p>
          <h2 ref={heading} id={`${panelId}-h`} tabIndex={-1} className="text-lg font-semibold outline-none">
            <span className="sr-only">Task #{ref} </span>
            {row?.title ?? ""}
          </h2>
        </div>
        <Button aria-label={closeTaskLabel(ref)} title={WORK_COPY.closeRowHint} onClick={onClose}>
          <X size={14} aria-hidden />
          {WORK_COPY.closeRow}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-300">
        <Loader2 size={14} aria-hidden className="animate-spin" />
        {WORK_COPY.opening}
      </p>
      {row ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-600 dark:text-neutral-300">
          <Chip tone={row.tone}>{row.statusLabel}</Chip>
          {row.stage ? (
            <span>
              {row.stage.n} {row.stage.label}
            </span>
          ) : null}
          {row.brand ? <span>{row.brand}</span> : null}
          {row.mustHave ? <Chip tone="violet">Must have</Chip> : null}
        </div>
      ) : null}
    </section>
  );
}

/** A task that can't be shown in place: none the person sees, or its region didn't answer. */
export function MissingRowPanel({ message, panelId, onClose }: { message: string; panelId: string; onClose: () => void }) {
  const close = useRef<HTMLSpanElement>(null);
  useEffect(() => close.current?.querySelector("button")?.focus({ preventScroll: true }), []);
  return (
    <section
      id={panelId}
      aria-label={message}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      className="flex flex-wrap items-center gap-3 bg-white p-4 text-sm dark:bg-neutral-950"
    >
      <p role="alert" className="flex-1 text-neutral-700 dark:text-neutral-300">
        {message}
      </p>
      <span ref={close}>
        <Button onClick={onClose}>
          <X size={14} aria-hidden />
          {WORK_COPY.closeRow}
        </Button>
      </span>
    </section>
  );
}

/** The words for a task that can't be opened in place. */
export function missingWords(kind: "none" | "unread", regions: readonly string[] = []): string {
  return kind === "none" ? WORK_COPY.noSuchTask : regionsDownText(regions);
}
