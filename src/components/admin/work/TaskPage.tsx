"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Button, inputClass } from "@/components/admin/connect/ui";
import { stageLabel } from "@/lib/work/stages";
import { WORK_COPY } from "@/lib/work/screenWords";
import { WORK_LIMITS } from "@/lib/work/types";
import type { TaskScreen } from "@/lib/work/screens";
import { workCall, workErrorText } from "./api";
import { useFocusSwap } from "./useFocusSwap";
import { Decisions } from "./Decisions";
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
  SIDE_LABEL,
  StageField,
  StatusField,
  TaskChips,
  taskBits,
  VizzySuggested,
  WaitingBanner,
} from "./TaskSections";
import { useTaskPatch } from "./useTaskPatch";

export { DescriptionText, historyLine } from "./TaskSections";

type TextFields = { title: string; description: string; notes: string };

/**
 * What Edit's Save sends: only the fields the person changed since the box opened, so a teammate's
 * change to another field, read in since, is never sent back over.
 */
export function textEdits(seed: TextFields, draft: TextFields): Partial<TextFields> {
  const out: Partial<TextFields> = {};
  if (draft.title.trim() !== seed.title.trim()) out.title = draft.title.trim();
  if (draft.description !== seed.description) out.description = draft.description;
  if (draft.notes !== seed.notes) out.notes = draft.notes;
  return out;
}

/**
 * One task (/admin/work/[ref]): its title and status, where it came from, a due check's buttons, its
 * description and notes, Connected to and Other links, its decisions and history; beside them its
 * stage, brand, idea, check, what it waits for, Must have and How we'll know it worked. Every change
 * goes through the task route and shows in History with who made it. The sections are shared with
 * the open row on Work's list (src/components/admin/work/TaskSections.tsx).
 */
export function TaskPage({ screen }: { screen: TaskScreen }) {
  const router = useRouter();
  const { page, me } = screen;
  const task = page.task;
  const { patch: sendPatch, busy, error, notice, clearNotice } = useTaskPatch(task);
  // A check's answer: kept here, since the answered check leaves the page when it reads itself again.
  // Any next action clears it and the change's notice, so the line never says what the page no longer does.
  const [checkSaid, setCheckSaid] = useState<string | null>(null);
  const startAction = () => {
    setCheckSaid(null);
    clearNotice();
  };
  const patch = (body: Parameters<typeof sendPatch>[0]) => {
    setCheckSaid(null);
    return sendPatch(body);
  };
  // Edit's box: what it opened on (null while closed) and the person's text, both from the task as it is when Edit is pressed.
  const [textSeed, setTextSeed] = useState<TextFields | null>(null);
  const [text, setText] = useState<TextFields>({ title: task.title, description: task.description, notes: task.notes });
  const editText = textSeed !== null;
  const { title, description, notes } = text;
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { lastMove, open, waitingOn } = taskBits(screen, task, page);
  const meta = [task.stage ? stageLabel(task.stage) : null, screen.multiBrand ? (page.brandName ?? "Whole business") : null].filter(Boolean).join(" · ");
  // Each editor that opens in place of its button takes focus in, and gives it back when it closes.
  const textFocus = useFocusSwap(editText);

  const openText = () => {
    const seed = { title: task.title, description: task.description, notes: task.notes };
    setText(seed);
    setTextSeed(seed);
  };
  const saveText = async () => {
    const body = textEdits(textSeed ?? text, text);
    if (!Object.keys(body).length || (await patch(body))) setTextSeed(null);
  };
  const remove = async () => {
    if (!window.confirm(WORK_COPY.deleteConfirm)) return;
    setDeleting(true);
    const r = await workCall(`/tasks/${task.ref}`, "DELETE");
    setDeleting(false);
    if (!r.ok) return setDeleteError(workErrorText(r.data));
    router.push("/admin/work");
    router.refresh();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-6">
        <Link href="/admin/work" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200">
          <ArrowLeft size={14} aria-hidden />
          All tasks
        </Link>
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-neutral-400">Task #{task.ref}</p>
          {editText ? (
            <input
              ref={textFocus.form}
              type="text"
              aria-label="Title"
              maxLength={WORK_LIMITS.title}
              value={title}
              onChange={(e) => setText({ ...text, title: e.target.value })}
              className={`${inputClass} text-lg font-semibold`}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{task.title}</h1>
              <TaskChips task={task} waitingOn={waitingOn} ideaWords={screen.ideaWords} />
            </div>
          )}
          {meta ? <p className="text-sm text-neutral-500 dark:text-neutral-400">{meta}</p> : null}
          <OriginLine screen={screen} task={task} page={page} />
          <VizzySuggested screen={screen} />
        </div>

        <RegionsDownNote page={page} />
        <DueCheckBanner screen={screen} task={task} page={page} via="work_page" onStart={startAction} onSaid={setCheckSaid} />
        <WaitingBanner waitingOn={waitingOn} open={open} />
        {notice || checkSaid ? (
          <p role="status" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
            {[checkSaid, notice].filter(Boolean).join(" ")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="flex items-start gap-1.5 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : null}

        <StatusField screen={screen} page={page} status={task.status} lastMove={lastMove} disabled={busy} onPick={(s) => void patch({ status: s })} />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className={SIDE_LABEL}>Description</p>
            {!editText ? (
              <span ref={textFocus.opener}>
                <button type="button" onClick={openText} className="text-xs text-neutral-500 underline underline-offset-4">
                  Edit
                </button>
              </span>
            ) : null}
          </div>
          {editText ? (
            <>
              <textarea aria-label="Description" rows={4} maxLength={WORK_LIMITS.description} value={description} onChange={(e) => setText({ ...text, description: e.target.value })} className={inputClass} />
              <p className={SIDE_LABEL}>Notes</p>
              <textarea aria-label="Notes" rows={3} maxLength={WORK_LIMITS.notes} value={notes} onChange={(e) => setText({ ...text, notes: e.target.value })} className={inputClass} />
              <div className="flex gap-2">
                <Button tone="primary" disabled={busy || !title.trim()} onClick={() => void saveText()}>
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button onClick={() => setTextSeed(null)}>Cancel</Button>
              </div>
            </>
          ) : (
            <>
              {task.description ? <DescriptionText text={task.description} /> : <p className="text-sm text-neutral-400">No description yet.</p>}
              <p className={SIDE_LABEL}>Notes</p>
              {task.notes ? <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">{task.notes}</p> : <p className="text-sm text-neutral-400">No notes yet.</p>}
            </>
          )}
        </div>

        <LinksSection screen={screen} task={task} page={page} onTyped={(typedLinks) => void patch({ typedLinks })} onFree={(links) => void patch({ links })} />

        <Decisions taskRef={task.ref} decisions={page.decisions} typedLinks={task.typedLinks} me={me} names={page.names} timeZone={page.timeZone} today={screen.today} drafted={screen.draftedDecision} />

        <HistorySection screen={screen} task={task} page={page} />
      </div>

      <aside aria-label="Details" className="space-y-5">
        <div className="space-y-4 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <StageField value={task.stage} disabled={busy} onChange={(stage) => void patch({ stage })} />
          <BrandField screen={screen} page={page} value={task.brandId} disabled={busy} onChange={(brandId) => void patch({ brandId })} />
          <IdeaField screen={screen} task={task} page={page} />
          <CheckField
            screen={screen}
            task={task}
            page={page}
            busy={busy}
            onSave={(check) => patch({ check })}
            onMoved={(said) => {
              startAction();
              setCheckSaid(said);
            }}
          />
          <BlockedByField screen={screen} page={page} busy={busy} onSave={(blockedBy) => patch({ blockedBy })} />
          <MustHaveField value={task.mustHave} disabled={busy} onChange={(mustHave) => void patch({ mustHave })} />
          <div className="space-y-1">
            <p className={SIDE_LABEL}>Ref</p>
            <p className="tabular-nums">#{task.ref}</p>
          </div>
        </div>
        <MeasureCard screen={screen} task={task} page={page} busy={busy} onSave={(measure) => patch({ measure })} />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {screen.workVizzy ? `${WORK_COPY.vizzyFoot} ` : ""}
          {WORK_COPY.pageFoot}
        </p>
        {page.can.delete ? (
          <div className="space-y-1">
            <Button tone="danger" disabled={deleting} onClick={() => void remove()}>
              {deleting ? "Deleting…" : "Delete task"}
            </Button>
            {deleteError ? (
              <p role="alert" className="text-xs text-red-700 dark:text-red-400">
                {deleteError}
              </p>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
