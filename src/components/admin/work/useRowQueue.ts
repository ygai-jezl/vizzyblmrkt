"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  answered,
  checkChange,
  editorChange,
  enqueue,
  fromServer,
  linksChange,
  nextSend,
  openedNow,
  queueBusy,
  refused,
  setChange,
  shownTask,
  startQueue,
  tappedNow,
  type Opened,
  type RowChange,
  type RowCheckTap,
  type RowField,
  type RowPatch,
  type RowQueue,
} from "@/lib/work/quickEdit";
import { WORK_COPY } from "@/lib/work/screenWords";
import type { WorkTaskView } from "@/lib/work/service";
import type { TypedLink, WorkLink, WorkTask } from "@/lib/work/types";
import { workCall, workErrorText } from "./api";
import { checkNoticeOf } from "./CheckActions";

/**
 * The open row's line of changes (WORK_QUICK_EDIT_ENABLED), on src/lib/work/quickEdit.ts's rules:
 * one change in flight at a time, each built from the newest task the row knows; what was picked
 * shows at once and goes back only on a refusal; Stage and Brand wait half a second after the last
 * pick; nothing is disabled while saving; and the row reads the task again once, when the line is
 * empty, or at once after a refusal. Changes go with via work_list, so History reads them as edits
 * made on the list.
 */

export type TextField = "title" | "description" | "notes";

/** The row's one status line: Saving…, Saved (or what Work did besides), or the refusal. */
export type RowStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; line: string } | { kind: "error"; line: string };

type Outcome = { ok: true; notice: string | null } | { ok: false; error: string };

const LATER_MS = 500;

export function useRowQueue(taskRef: number, serverView: WorkTaskView) {
  const router = useRouter();
  const q = useRef<RowQueue<WorkTaskView>>(startQueue(serverView));
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [status, setStatus] = useState<RowStatus>({ kind: "idle" });
  const [errors, setErrors] = useState<Partial<Record<RowField, string>>>({});
  const [kept, setKept] = useState<Partial<Record<TextField, string>>>({});
  // Stage and Brand picked but not sent yet: shown at once, sent half a second after the last pick.
  const [drafts, setDrafts] = useState<Partial<Pick<WorkTask, "stage" | "brandId">>>({});
  const timers = useRef(new Map<"stage" | "brandId", { timer: ReturnType<typeof setTimeout>; fire: () => void }>());
  const waiters = useRef(new Map<number, Array<(o: Outcome) => void>>());
  const idleWaiters = useRef<Array<(ok: boolean) => void>>([]);
  const pumping = useRef(false);
  const ids = useRef(1);
  const sentInBurst = useRef(false);
  const lastLine = useRef<string | null>(null);

  // The task as the server read it again (after a burst of changes, a refusal, or a decision).
  useEffect(() => {
    q.current = fromServer(q.current, serverView);
    bump();
  }, [serverView]);

  const settle = useCallback((id: number, o: Outcome) => {
    for (const w of waiters.current.get(id) ?? []) w(o);
    waiters.current.delete(id);
  }, []);

  const finishIdle = useCallback((ok: boolean) => {
    const w = idleWaiters.current;
    idleWaiters.current = [];
    for (const f of w) f(ok);
  }, []);

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      for (;;) {
        const step = nextSend(q.current);
        if (!step) break;
        q.current = step.queue;
        const { next } = step;
        if (next.skip) {
          settle(next.change.id, { ok: true, notice: null });
          continue;
        }
        sentInBurst.current = true;
        setStatus({ kind: "saving" });
        bump();
        const r =
          next.change.kind === "patch" && "body" in next
            ? await workCall<{ task: WorkTaskView; notice: string | null }>(`/tasks/${taskRef}`, "PATCH", { ...next.body, via: "work_list", baseUpdatedAt: next.stamp })
            : await workCall<{ task: WorkTaskView; notice: string | null }>("/checks", "POST", { ref: taskRef, ...("tap" in next ? next.tap : {}), via: "work_list", ...("setAt" in next ? { setAt: next.setAt } : {}) });
        if (r.ok && r.data.task) {
          q.current = answered(q.current, r.data.task);
          const notice = r.data.notice ?? null;
          lastLine.current = next.change.kind === "check" ? checkNoticeOf(notice) : notice ? `${WORK_COPY.saved}. ${notice}` : lastLine.current;
          settle(next.change.id, { ok: true, notice });
          continue;
        }
        // A refusal: what waits is dropped and goes back, typed text goes back in its box, and the row reads the task again.
        const changed = (r.data as { error?: string }).error === "changed";
        const message = workErrorText(r.data);
        const out = refused(q.current);
        q.current = out.queue;
        for (const [field, t] of timers.current) {
          clearTimeout(t.timer);
          timers.current.delete(field);
        }
        setDrafts({});
        const texts: Partial<Record<TextField, string>> = {};
        for (const c of out.dropped) if (c.kind === "patch" && c.text !== undefined) texts[c.field as TextField] = c.text;
        setKept((k) => ({ ...k, ...texts }));
        setErrors((e) => ({ ...e, [next.change.field]: changed ? WORK_COPY.rowChangedShort : message }));
        setStatus({ kind: "error", line: changed ? (Object.keys(texts).length ? WORK_COPY.rowChanged : WORK_COPY.rowChangedPick) : message });
        for (const c of out.dropped) settle(c.id, { ok: false, error: changed ? WORK_COPY.rowChangedShort : message });
        sentInBurst.current = false;
        lastLine.current = null;
        bump();
        router.refresh();
        finishIdle(false);
        return;
      }
      // The line is empty: one read for the whole burst.
      if (sentInBurst.current) {
        setStatus({ kind: "saved", line: lastLine.current ?? WORK_COPY.saved });
        sentInBurst.current = false;
        lastLine.current = null;
        router.refresh();
      }
      bump();
      if (timers.current.size === 0) finishIdle(true);
    } finally {
      pumping.current = false;
    }
  }, [taskRef, router, settle, finishIdle]);

  const push = useCallback(
    (change: RowChange): Promise<Outcome> => {
      const { queue, replaced } = enqueue(q.current, change);
      q.current = queue;
      const mine: Array<(o: Outcome) => void> = [];
      for (const r of replaced) {
        mine.push(...(waiters.current.get(r.id) ?? []));
        waiters.current.delete(r.id);
      }
      const done = new Promise<Outcome>((resolve) => mine.push(resolve));
      waiters.current.set(change.id, mine);
      setErrors((e) => {
        if (!(change.field in e)) return e;
        const { [change.field]: _gone, ...rest } = e;
        return rest;
      });
      bump();
      void pump();
      return done;
    },
    [pump],
  );

  const id = () => ids.current++;

  /** Status or Must have: sent at once. */
  const pick = useCallback(<F extends "status" | "mustHave">(field: F, value: WorkTask[F]) => void push(setChange(id(), field, value)), [push]);

  /** Stage or Brand: shown at once, sent half a second after the last pick, so arrowing through a list sends one change. */
  const later = useCallback(
    <F extends "stage" | "brandId">(field: F, value: WorkTask[F]) => {
      setDrafts((d) => ({ ...d, [field]: value }));
      const was = timers.current.get(field);
      if (was) clearTimeout(was.timer);
      const fire = () => {
        const t = timers.current.get(field);
        if (t) clearTimeout(t.timer);
        timers.current.delete(field);
        setDrafts((d) => {
          const { [field]: _sent, ...rest } = d;
          return rest;
        });
        void push(setChange(id(), field, value));
      };
      timers.current.set(field, { timer: setTimeout(fire, LATER_MS), fire });
    },
    [push],
  );

  /** A text box's new text, with when it opened. An empty title isn't sent: the old one stays. */
  const text = useCallback(
    (field: TextField, value: string, opened: Opened | null) => {
      const v = field === "title" ? value.trim() : value;
      if (field === "title" && !v) return;
      void push(setChange(id(), field, v, opened, value));
    },
    [push],
  );

  /** A link added or removed: made on the newest task's links when it is sent. */
  const links = useCallback(
    (field: "typedLinks" | "links", before: readonly (TypedLink | WorkLink)[], after: readonly (TypedLink | WorkLink)[]) =>
      void push(field === "typedLinks" ? linksChange(id(), "typedLinks", before as TypedLink[], after as TypedLink[]) : linksChange(id(), "links", before as WorkLink[], after as WorkLink[])),
    [push],
  );

  /** A Save editor (blocked by, the check, the measure): true once it saved, so the editor closes. */
  const editor = useCallback(
    async (field: "blockedBy" | "check" | "measure", body: RowPatch, opened: Opened | null): Promise<boolean> => (await push(editorChange(id(), field, body, opened))).ok,
    [push],
  );

  /** A tap on a due check's buttons, or Move it: waits its turn, built on the check as it is then. */
  const check = useCallback(
    async (tap: RowCheckTap): Promise<{ ok: true; notice: string | null } | { ok: false; error: string }> => push(checkChange(id(), tap, tappedNow(q.current))),
    [push],
  );

  /** Send Stage and Brand now, then wait for the line to empty: false when a change was refused meanwhile. */
  const idle = useCallback((): Promise<boolean> => {
    for (const t of [...timers.current.values()]) t.fire();
    if (!queueBusy(q.current) && !pumping.current) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => idleWaiters.current.push(resolve));
  }, []);

  /** A text box has taken back what it held when its change was refused. */
  const clearKept = useCallback((field: TextField) => {
    setKept((k) => {
      if (k[field] === undefined) return k;
      const { [field]: _taken, ...rest } = k;
      return rest;
    });
  }, []);

  const shown: WorkTask = { ...shownTask(q.current), ...drafts };

  return {
    /** The task as the row shows it: the newest known, with what was just picked. */
    shown,
    /** The newest view the row knows (blockers, due, waiting), from an answer or the server. */
    view: q.current.known,
    status,
    errors,
    kept,
    busy: queueBusy(q.current) || timers.current.size > 0,
    opened: () => openedNow(q.current),
    pick,
    later,
    text,
    links,
    editor,
    check,
    idle,
    clearKept,
    clearStatus: () => setStatus({ kind: "idle" }),
  };
}
