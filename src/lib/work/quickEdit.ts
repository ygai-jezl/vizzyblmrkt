import type { EditTaskBody, WorkFilters } from "./inputs";
import { filtersHref } from "./list";
import type { TypedLink, WorkLink, WorkRead, WorkTask } from "./types";

/**
 * Quick edit on Work's list (WORK_QUICK_EDIT_ENABLED, plan-work-quick-edit section 4): the rules
 * the open row keeps, as pure functions, so they are tested without a browser. Plain data and
 * type imports only: the row runs these in the browser.
 *
 * The line of changes. Each open row sends one change at a time, so two changes never carry the
 * same stamp and refuse each other inside the server's write. An unsent change to a field is
 * replaced by a newer one to the same field (a link added or removed is never replaced: it builds
 * on the one before). Each change is built from the newest task the row knows, from its last
 * answer, so a second link added before the page reads itself again keeps the first. It is sent
 * with the newest stamp the row knows, or, for an editor (a text box, the check, the blocked by
 * search, the measure) that opened before someone else's change came in, with the stamp it opened
 * on, so that change is refused rather than overwritten without a word. Decisions don't change the
 * task's stamp, so they never wait here. On a refusal the changes still waiting are dropped,
 * their fields go back, and the row reads the task again.
 */

/** What the row changes: a task field, or a tap on its check. */
export type RowField = "title" | "description" | "notes" | "status" | "stage" | "brandId" | "mustHave" | "typedLinks" | "links" | "blockedBy" | "check" | "measure" | "checkAction";

export type RowPatch = Omit<EditTaskBody, "via" | "baseUpdatedAt">;

/** A tap on a check, as the checks route takes it. */
export type RowCheckTap = { action: "checked" } | { action: "look_again"; day?: string; time?: string } | { action: "read"; read: WorkRead };

/** When an editor opened: the stamp it saw (a task's updatedAt, or a check's setAt), and the row's epoch then. */
export interface Opened {
  stamp: string;
  epoch: number;
}

export type RowChange =
  | {
      id: number;
      kind: "patch";
      field: Exclude<RowField, "checkAction">;
      /** A newer change to the same field takes this one's place while it waits. */
      replace: boolean;
      /** The body from the newest task the row knows, or null when there is nothing left to send. */
      build: (task: WorkTask) => RowPatch | null;
      opened: Opened | null;
      /** What a text box held, put back in its box if the change is refused. */
      text?: string;
    }
  | { id: number; kind: "check"; field: "checkAction"; tap: RowCheckTap; opened: Opened };

/** The row's line: the newest task view it knows, the stamps that are its own, and what waits. */
export interface RowQueue<V extends { task: WorkTask }> {
  known: V;
  /** The stamp the row opened or last read on, then each of its own answers'. */
  own: string[];
  /** Goes up each time someone else's change comes in. */
  epoch: number;
  waiting: RowChange[];
  inFlight: RowChange | null;
}

export function startQueue<V extends { task: WorkTask }>(view: V): RowQueue<V> {
  return { known: view, own: [view.task.updatedAt], epoch: 0, waiting: [], inFlight: null };
}

/** Something is being sent, or waits to be. */
export function queueBusy(q: RowQueue<{ task: WorkTask }>): boolean {
  return q.inFlight !== null || q.waiting.length > 0;
}

/** The stamp it is the editor's turn to send with: the newest, unless someone else's change came in after it opened. */
export function stampFor(q: RowQueue<{ task: WorkTask }>, opened: Opened | null): string {
  return opened === null || opened.epoch === q.epoch ? q.known.task.updatedAt : opened.stamp;
}

/** When an editor opening now opened, on the task's stamp. */
export function openedNow(q: RowQueue<{ task: WorkTask }>): Opened {
  return { stamp: q.known.task.updatedAt, epoch: q.epoch };
}

/** When a check tap now was made, on the check's setAt (empty when there is no check). */
export function tappedNow(q: RowQueue<{ task: WorkTask }>): Opened {
  return { stamp: q.known.task.check?.setAt ?? "", epoch: q.epoch };
}

/** Add a change to the line. A replacing change drops an unsent one to the same field, which is returned. */
export function enqueue<V extends { task: WorkTask }>(q: RowQueue<V>, change: RowChange): { queue: RowQueue<V>; replaced: RowChange[] } {
  const replaces = change.kind === "patch" && change.replace;
  const replaced = replaces ? q.waiting.filter((c) => c.field === change.field) : [];
  const kept = replaces ? q.waiting.filter((c) => c.field !== change.field) : q.waiting;
  return { queue: { ...q, waiting: [...kept, change] }, replaced };
}

export type Next = { change: RowChange; skip: true } | { change: Extract<RowChange, { kind: "patch" }>; skip: false; body: RowPatch; stamp: string } | { change: Extract<RowChange, { kind: "check" }>; skip: false; tap: RowCheckTap; setAt: string };

/**
 * The next change to send, built from the newest task, and the line with it in flight; null while
 * one is in flight or nothing waits. `skip`: it has nothing left to send (the value is already
 * the task's, or the check it answers is gone), so it is done without a call.
 */
export function nextSend<V extends { task: WorkTask }>(q: RowQueue<V>): { queue: RowQueue<V>; next: Next } | null {
  if (q.inFlight || q.waiting.length === 0) return null;
  const [change, ...rest] = q.waiting as [RowChange, ...RowChange[]];
  if (change.kind === "patch") {
    const body = change.build(q.known.task);
    if (!body || Object.keys(body).length === 0) return { queue: { ...q, waiting: rest }, next: { change, skip: true } };
    return { queue: { ...q, waiting: rest, inFlight: change }, next: { change, skip: false, body, stamp: stampFor(q, change.opened) } };
  }
  const own = change.opened.epoch === q.epoch;
  const setAt = own ? (q.known.task.check?.setAt ?? null) : change.opened.stamp;
  if (!setAt) return { queue: { ...q, waiting: rest }, next: { change, skip: true } };
  return { queue: { ...q, waiting: rest, inFlight: change }, next: { change, skip: false, tap: change.tap, setAt } };
}

/** The answer to what was in flight: the task it made is the newest, and its stamp the row's own. */
export function answered<V extends { task: WorkTask }>(q: RowQueue<V>, view: V): RowQueue<V> {
  return { ...q, known: view, own: [...q.own, view.task.updatedAt], inFlight: null };
}

/** A refusal: nothing is in flight or waits any more; what was dropped goes back. */
export function refused<V extends { task: WorkTask }>(q: RowQueue<V>): { queue: RowQueue<V>; dropped: RowChange[] } {
  return { queue: { ...q, inFlight: null, waiting: [] }, dropped: [...(q.inFlight ? [q.inFlight] : []), ...q.waiting] };
}

/**
 * The task as the server read it again. While a change is in flight the read waits for the next
 * one (it may hold that change before its answer does). The same stamp as the newest: its fresher
 * words are taken. One of the row's own older stamps: it is stale, and left. Any other stamp is
 * someone else's change: it is taken, becomes the row's start again, and the epoch goes up.
 */
export function fromServer<V extends { task: WorkTask }>(q: RowQueue<V>, view: V): RowQueue<V> {
  if (q.inFlight) return q;
  const s = view.task.updatedAt;
  if (s === q.known.task.updatedAt) return { ...q, known: view };
  if (q.own.includes(s)) return q;
  return { ...q, known: view, own: [s], epoch: q.epoch + 1 };
}

/** The task as the row shows it: the newest it knows, with what is in flight and waits already in. */
export function shownTask(q: RowQueue<{ task: WorkTask }>): WorkTask {
  let t = q.known.task;
  for (const c of [...(q.inFlight ? [q.inFlight] : []), ...q.waiting]) {
    if (c.kind === "patch") t = withPatch(t, c.build(t));
  }
  return t;
}

/** The fields a change shows at once. What a Save editor sends (blockers, check, measure) shows once it saved. */
export function withPatch(t: WorkTask, body: RowPatch | null): WorkTask {
  if (!body) return t;
  const out = { ...t };
  if (body.title !== undefined) out.title = body.title;
  if (body.description !== undefined) out.description = body.description;
  if (body.notes !== undefined) out.notes = body.notes;
  if (body.status !== undefined) out.status = body.status;
  if (body.stage !== undefined) out.stage = body.stage;
  if (body.brandId !== undefined) out.brandId = body.brandId;
  if (body.mustHave !== undefined) out.mustHave = body.mustHave;
  if (body.typedLinks !== undefined) out.typedLinks = body.typedLinks;
  if (body.links !== undefined) out.links = body.links;
  return out;
}

// --- Changes -------------------------------------------------------------------------------------

type SetField = "title" | "description" | "notes" | "status" | "stage" | "brandId" | "mustHave";

/** One field set to a value, sent only if it differs from the newest task's. Replaces an unsent one. */
export function setChange<F extends SetField>(id: number, field: F, value: WorkTask[F], opened: Opened | null = null, text?: string): RowChange {
  return {
    id,
    kind: "patch",
    field,
    replace: true,
    opened,
    ...(text !== undefined ? { text } : {}),
    build: (t) => (t[field] === value ? null : ({ [field]: value } as RowPatch)),
  };
}

/** A Save editor's body, sent as it is: the blocked by search, the check or the measure. */
export function editorChange(id: number, field: "blockedBy" | "check" | "measure", body: RowPatch, opened: Opened | null): RowChange {
  return { id, kind: "patch", field, replace: true, opened, build: () => body };
}

/** A tap on the check: Mark checked, Look again, a read, or a new date. */
export function checkChange(id: number, tap: RowCheckTap, opened: Opened): RowChange {
  return { id, kind: "check", field: "checkAction", tap, opened };
}

/** A key that is the same for the same link, whatever order its fields came in. */
function linkKey(l: unknown): string {
  return JSON.stringify(l, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v));
}

/** What an editor's new list added to and took from the list it was given, each link as often as it was. */
export function listEdit<T>(before: readonly T[], after: readonly T[]): { added: T[]; removed: T[] } {
  const left = new Map<string, number>();
  for (const l of before) left.set(linkKey(l), (left.get(linkKey(l)) ?? 0) + 1);
  const added: T[] = [];
  for (const l of after) {
    const k = linkKey(l);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else added.push(l);
  }
  const removed: T[] = [];
  const gone = new Map(left);
  for (const l of before) {
    const k = linkKey(l);
    const n = gone.get(k) ?? 0;
    if (n > 0) {
      removed.push(l);
      gone.set(k, n - 1);
    }
  }
  return { added, removed };
}

/** The same edit made on another list: what was removed goes, once each, and what was added comes, unless it is there. */
export function applyListEdit<T>(list: readonly T[], edit: { added: readonly T[]; removed: readonly T[] }): T[] {
  const out = [...list];
  for (const r of edit.removed) {
    const at = out.findIndex((l) => linkKey(l) === linkKey(r));
    if (at >= 0) out.splice(at, 1);
  }
  for (const a of edit.added) if (!out.some((l) => linkKey(l) === linkKey(a))) out.push(a);
  return out;
}

/**
 * A link added or removed in Connected to or Other links: the editor's new list, turned into what
 * it added and removed, and made on the newest task's list when it is sent. Never replaced.
 */
export function linksChange(id: number, field: "typedLinks", before: readonly TypedLink[], after: readonly TypedLink[]): RowChange;
export function linksChange(id: number, field: "links", before: readonly WorkLink[], after: readonly WorkLink[]): RowChange;
export function linksChange(id: number, field: "typedLinks" | "links", before: readonly unknown[], after: readonly unknown[]): RowChange {
  const edit = listEdit(before, after);
  return {
    id,
    kind: "patch",
    field,
    replace: false,
    opened: null,
    build: (t) => {
      const cur = t[field] as readonly unknown[];
      const next = applyListEdit(cur, edit);
      return linkKey(next) === linkKey(cur) ? null : ({ [field]: next } as RowPatch);
    },
  };
}

// --- The list around the open row ----------------------------------------------------------------

/** The list's address with this task open in place, or with none open: the filters kept, as the list has them. */
export function openHref(filters: WorkFilters, ref: number | null): string {
  const base = filtersHref(filters);
  return ref === null ? base : `${base}${base.includes("?") ? "&" : "?"}open=${ref}`;
}

/**
 * The order the list holds for the whole visit (decision 2): rows already shown keep their place
 * whatever changed, and rows new to it (a task just added, one opened from elsewhere) go on top.
 * With nothing held yet, or after Sort again, it is the server's order.
 */
export function holdOrder(held: readonly string[] | null, now: readonly string[]): string[] {
  if (!held) return [...now];
  const there = new Set(now);
  const seen = new Set(held);
  return [...now.filter((id) => !seen.has(id)), ...held.filter((id) => there.has(id))];
}

/** Sorting again would move a row: Sort again shows beside the order line. */
export function wouldMove(shown: readonly string[], server: readonly string[]): boolean {
  const there = new Set(server);
  const mine = shown.filter((id) => there.has(id));
  return mine.length !== server.length || mine.some((id, i) => id !== server[i]);
}

/**
 * Where focus goes when a row closes: back to its Ref button, or, when the task left the list, to
 * the next row's, the one before, or the list itself (null), saying it left.
 */
export function focusAfterClose(before: readonly number[], after: readonly number[], ref: number): { ref: number | null; left: boolean } {
  if (after.includes(ref)) return { ref, left: false };
  const at = before.indexOf(ref);
  const next = before.slice(at + 1).find((r) => after.includes(r)) ?? [...before.slice(0, Math.max(0, at))].reverse().find((r) => after.includes(r)) ?? null;
  return { ref: next, left: true };
}

/** The cells of a row a click can land on, as WorkRowCells marks them. */
export const ROW_CELLS = ["ref", "title", "must", "vizzy", "pr", "status", "stage", "brand", "idea", "block", "wait", "check"] as const;
export type RowCell = (typeof ROW_CELLS)[number];

export function rowCellOf(v: string | undefined): RowCell {
  return (ROW_CELLS as readonly string[]).includes(v ?? "") ? (v as RowCell) : "title";
}

/**
 * Which field the open row puts focus on for a clicked cell: its heading for the ref and the
 * title, never a text box; the field the cell shows; or an editor opened there (the blocked by
 * search, or the check's picker, or Move its date). A due check focuses its buttons.
 */
export function cellFocus(cell: RowCell, o: { multiBrand: boolean; due: boolean }): { mark: string; start?: "block" | "check" } {
  switch (cell) {
    case "must":
      return { mark: "must" };
    case "vizzy":
      return { mark: "vizzy" };
    case "pr":
      return { mark: "links" };
    case "status":
      return { mark: "status" };
    case "stage":
      return { mark: "stage" };
    case "brand":
      return o.multiBrand ? { mark: "brand" } : { mark: "heading" };
    case "idea":
      return { mark: "idea" };
    case "block":
      return { mark: "block", start: "block" };
    case "check":
      return o.due ? { mark: "check-due" } : { mark: "check", start: "check" };
    default:
      return { mark: "heading" };
  }
}

/**
 * What a click on a row does: opens the row; leaves a link to the browser (Cmd or Ctrl click, a
 * shift click or a middle click, which open the task's full page elsewhere); or nothing, while
 * text is being selected or for another button.
 */
export function clickIntent(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, selection: string, onLink: boolean): "open" | "page" | "ignore" {
  if (onLink && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return "page";
  if (selection.length > 0) return "ignore";
  if (e.button !== 0 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return "ignore";
  return "open";
}

// --- Leaving the row, Esc and its status line ------------------------------------------------------

/** An editor open in the row, as the rules below read it: a text box saves what it holds, the others ask. */
export interface EditorState {
  label: string;
  dirty: boolean;
  /** A text box (the title, description or notes). */
  text: boolean;
}

/**
 * Leaving the row (Close, another row, a filter, Open the full page, Make it an idea): every text
 * box saves what it holds, and an editor with a Save button that holds unsaved input asks first,
 * the newest of them. Otherwise the row waits for its saves, then goes.
 */
export function leaveStep(editors: readonly EditorState[]): { save: number[]; ask: string | null } {
  const save = editors.flatMap((e, i) => (e.text ? [i] : []));
  const asking = editors.filter((e) => !e.text && e.dirty);
  return { save, ask: asking.length ? asking[asking.length - 1]!.label : null };
}

/**
 * Esc inside the open row, the innermost thing first: the unsaved changes question (Keep editing),
 * then Delete's confirm, then the newest editor with a Save button (asking first when it holds
 * input), then the row. A text box and a list of choices take their own Esc before this.
 */
export type EscapeStep = { kind: "keep" } | { kind: "cancel_delete" } | { kind: "ask"; at: number } | { kind: "close_editor"; at: number } | { kind: "close_row" };

export function escapeStep(o: { asking: boolean; confirmingDelete: boolean; editors: readonly EditorState[] }): EscapeStep {
  if (o.asking) return { kind: "keep" };
  if (o.confirmingDelete) return { kind: "cancel_delete" };
  for (let i = o.editors.length - 1; i >= 0; i--) {
    const e = o.editors[i]!;
    if (e.text) continue;
    return e.dirty ? { kind: "ask", at: i } : { kind: "close_editor", at: i };
  }
  return { kind: "close_row" };
}

/** What the status line says once a change is answered: a check's notice; a change's, after Saved; else what it said. */
export function answerLine(said: string | null, kind: "patch" | "check", notice: string | null, words: { saved: string; checked: string }): string | null {
  if (kind === "check") return notice ?? words.checked;
  return notice ? `${words.saved}. ${notice}` : said;
}

/**
 * What a refusal says on the status line: someone else's change, with typed text kept in its box
 * or not, or the refusal's own words.
 */
export function refusalLine(o: { changed: boolean; keptText: boolean; message: string }, words: { changed: string; changedPick: string }): string {
  if (!o.changed) return o.message;
  return o.keptText ? words.changed : words.changedPick;
}
