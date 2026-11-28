import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_TASKS } from "@/lib/tenant";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { filtersOf } from "./inputs";
import type { WorkResult } from "./result";
import { listFiltersOf, listScreen, openRow, taskScreen } from "./screens";
import { addTask, editTask, taskPage } from "./service";
import { sharedReads, type WorkDeps } from "./scope";
import { makeWorld, PEOPLE, type World } from "./testing/world";
import { aStoredTask, LUMEN_EU, LUMEN_US } from "./testing/fixtures";
import {
  answerLine,
  answered,
  applyListEdit,
  escapeStep,
  leaveStep,
  refusalLine,
  cellFocus,
  checkChange,
  clickIntent,
  focusAfterClose,
  holdOrder,
  openHref,
  rowCellOf,
  wouldMove,
  editorChange,
  enqueue,
  fromServer,
  linksChange,
  listEdit,
  nextSend,
  openedNow,
  queueBusy,
  refused,
  setChange,
  shownTask,
  stampFor,
  startQueue,
  tappedNow,
  type RowQueue,
} from "./quickEdit";
import type { TypedLink, WorkTask } from "./types";

// Quick edit on Work's list (WORK_QUICK_EDIT_ENABLED), on the server: the task opened in place
// beside the list, the row kept when the filters leave it out, and one page load's shared read.
// Lumen [made up] has Lumen Notes in the United States and Lumen Europe; Nina owns it, Sam is a
// member of Lumen Notes and Leo an admin of Lumen Europe.

let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.value;
}
const add = async (who: TenantContext, body: Parameters<typeof addTask>[1]) => value(await addTask(await w.scope(who), body, w.deps)).task.task;
const open = async (who: TenantContext, ref: number, q = "", deps: WorkDeps = w.deps) => {
  const scope = await w.scope(who);
  return openRow(scope, ref, listFiltersOf(scope, new URLSearchParams(q)), deps);
};

describe("the open row on the server", () => {
  it("is the task's screen, as its page has it, with its row, not kept while the filters show it", async () => {
    const t = await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, mustHave: true, stage: "billing_tax" });
    const r = await open(PEOPLE.nina, t.ref);
    if (r.kind !== "task") throw new Error(r.kind);
    const page = (await taskScreen(await w.scope(PEOPLE.nina), t.ref, w.deps))!;
    expect(r.screen).toEqual(page);
    expect(r.screen.draftedDecision).toBeNull();
    expect(r.kept).toBe(false);
    expect(r.row).toMatchObject({ ref: t.ref, title: "Credits and pricing page", mustHave: true, brand: "Lumen Notes", stage: { n: 7, label: "Billing and tax" } });
  });

  it("keeps the row of a task set Done under Status Open, or moved to another brand under one brand", async () => {
    const t = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_US });
    value(await editTask(await w.scope(PEOPLE.nina), t.ref, { status: "done" }, w.deps));
    const done = await open(PEOPLE.nina, t.ref);
    expect(done).toMatchObject({ kind: "task", kept: true, row: { status: "done", closed: true } });
    expect(await open(PEOPLE.nina, t.ref, "status=all")).toMatchObject({ kind: "task", kept: false });
    expect(await open(PEOPLE.nina, t.ref, `status=all&brand=${LUMEN_EU}`)).toMatchObject({ kind: "task", kept: true });
    expect(await open(PEOPLE.nina, t.ref, "status=all&must=1")).toMatchObject({ kind: "task", kept: true });
  });

  it("is none for another brand's ref in the brand view, and for a ref that isn't there", async () => {
    const eu = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    expect(await open(PEOPLE.sam, eu.ref)).toEqual({ kind: "none", ref: eu.ref });
    expect(await open(PEOPLE.nina, 999)).toEqual({ kind: "none", ref: 999 });
  });

  it("is unread when the region that holds it didn't answer, where the task page says not found", async () => {
    const eu = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    const broken = failingFirestore(w.eu, { collections: [WORK_TASKS] });
    const deps: WorkDeps = { ...w.deps, regionDb: (r) => (r === "eu" ? broken : w.dbOf(r)) };
    expect(await open(PEOPLE.nina, eu.ref, "", deps)).toEqual({ kind: "unread", ref: eu.ref, regions: ["Europe"] });
    expect(await taskPage(await w.scope(PEOPLE.nina), eu.ref, deps)).toMatchObject({ ok: false, error: "not_found" });
    // A task found in a region that answered still opens, saying another region didn't.
    const us = await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US });
    const r = await open(PEOPLE.nina, us.ref, "", deps);
    expect(r.kind === "task" && r.screen.page.regionsDown).toEqual([{ region: "eu", name: "Europe" }]);
  });
});

describe("one page load's shared read", () => {
  async function seed() {
    const a = await add(PEOPLE.nina, { title: "Template gallery page", brandId: LUMEN_US });
    const b = await add(PEOPLE.nina, { title: "Write the help page", brandId: LUMEN_US });
    const t = await add(PEOPLE.nina, { title: "Templates for team notes", brandId: LUMEN_US, blockedBy: [a.ref, b.ref] });
    return { a, b, t };
  }

  it("runs once on the default view for the list, the pickers and the blockers, and gives what each reads alone", async () => {
    const { t } = await seed();
    const scope = await w.scope(PEOPLE.nina);
    const shared = sharedReads();
    const deps = { ...w.deps, shared };
    const params = new URLSearchParams("");
    const [list, row] = await Promise.all([listScreen(scope, params, deps), openRow(scope, t.ref, listFiltersOf(scope, params), deps)]);
    expect(shared.reads).toBe(1);
    expect(list).toEqual(await listScreen(scope, params, w.deps));
    if (row.kind !== "task") throw new Error(row.kind);
    expect(row.screen).toEqual(await taskScreen(scope, t.ref, w.deps));
    expect(row.screen.page.blockers.map((b) => ("ref" in b ? b.title : "?"))).toEqual(["Template gallery page", "Write the help page"]);
  });

  it("runs once more under a brand or status filter, since the pickers need every brand's open tasks", async () => {
    const { t } = await seed();
    const scope = await w.scope(PEOPLE.nina);
    for (const q of [`brand=${LUMEN_US}`, "status=all"]) {
      const shared = sharedReads();
      const deps = { ...w.deps, shared };
      const params = new URLSearchParams(q);
      await Promise.all([listScreen(scope, params, deps), openRow(scope, t.ref, listFiltersOf(scope, params), deps)]);
      expect(shared.reads, q).toBe(2);
    }
  });

  it("is the brand view's own under Open, once, for a member", async () => {
    const t = await add(PEOPLE.sam, { title: "Interview 5 team admins" });
    const scope = await w.scope(PEOPLE.sam);
    const shared = sharedReads();
    const deps = { ...w.deps, shared };
    const params = new URLSearchParams(`brand=${LUMEN_EU}`);
    await Promise.all([listScreen(scope, params, deps), openRow(scope, t.ref, listFiltersOf(scope, params), deps)]);
    expect(shared.reads).toBe(1);
  });

  it("looks the blockers up in it, not one by one in each region", async () => {
    const { t } = await seed();
    const scope = await w.scope(PEOPLE.nina);
    const reads = () => w.us.collectionCalls(WORK_TASKS) + w.eu.collectionCalls(WORK_TASKS) + w.asia.collectionCalls(WORK_TASKS);
    const shared = sharedReads();
    const deps = { ...w.deps, shared };
    await listScreen(scope, new URLSearchParams(""), deps);
    const before = reads();
    await openRow(scope, t.ref, filtersOf(new URLSearchParams("")), deps);
    const withShared = reads() - before;
    const alone = reads();
    await openRow(scope, t.ref, filtersOf(new URLSearchParams("")), w.deps);
    const withoutShared = reads() - alone;
    // Shared: only the read for the task by its ref, in each region. Alone: that, the pickers' own
    // read (3 queries in each region) and each of the 2 blockers in each region.
    expect(withShared).toBe(3);
    expect(withoutShared).toBe(3 + 9 + 6);
  });
});

describe("the task page's team names", () => {
  it("are read for every brand side by side, and are the same names one after another gave", async () => {
    const t = await add(PEOPLE.nina, { title: "Whole business pricing", brandId: null });
    const eu = await add(PEOPLE.leo, { title: "Cookie notice in German" });
    value(await editTask(await w.scope(PEOPLE.nina), eu.ref, { notes: "Leo checks the German first" }, w.deps));
    const page = value(await taskPage(await w.scope(PEOPLE.nina), eu.ref, w.deps));
    expect(page.names).toEqual({ uid_nina: "nina", uid_leo: "leo" });
    expect(value(await taskPage(await w.scope(PEOPLE.nina), t.ref, w.deps)).names).toEqual({ uid_nina: "nina" });
  });
});

// --- The line of changes (pure) ------------------------------------------------------------------

type View = { task: WorkTask };
const S0 = "2026-11-25T09:00:00.000Z";
const at = (n: number) => `2026-11-25T09:00:0${n}.000Z`;
const view = (over: Partial<WorkTask> = {}): View => ({ task: aStoredTask({ updatedAt: S0, ...over }) });
const PLAN: TypedLink = { kind: "plan", url: "https://docs.example.com/plan", title: "Plan" };
const PR: TypedLink = { kind: "pull_request", provider: "github", repo: "Lumen-Example/notes-app", number: 84 };

/** Send what is next, as the row does, and give back the line with it in flight. */
function send(q: RowQueue<View>) {
  const s = nextSend(q);
  if (!s) throw new Error("nothing to send");
  return s;
}

describe("the line of changes", () => {
  it("sends one change at a time, and only what changed", () => {
    let q = startQueue(view());
    q = enqueue(q, setChange(1, "status", "in_progress")).queue;
    q = enqueue(q, setChange(2, "mustHave", true)).queue;
    const first = send(q);
    expect(first.next).toMatchObject({ skip: false, body: { status: "in_progress" }, stamp: S0 });
    q = first.queue;
    expect(nextSend(q)).toBeNull();
    expect(queueBusy(q)).toBe(true);
    q = answered(q, view({ status: "in_progress", updatedAt: at(1) }));
    expect(send(q).next).toMatchObject({ body: { mustHave: true }, stamp: at(1) });
    // A pick of the value it has already is done without a call.
    const same = enqueue(startQueue(view({ stage: "market" })), setChange(3, "stage", "market")).queue;
    expect(send(same).next).toMatchObject({ skip: true });
  });

  it("shows what was picked at once, and puts it back on a refusal, dropping what waits", () => {
    let q = startQueue(view({ title: "Old title" }));
    q = enqueue(q, setChange(1, "status", "done")).queue;
    q = enqueue(q, setChange(2, "title", "New title", openedNow(q), "New title")).queue;
    expect(shownTask(q)).toMatchObject({ status: "done", title: "New title" });
    q = send(q).queue;
    const out = refused(q);
    expect(out.dropped.map((c) => c.id)).toEqual([1, 2]);
    expect(queueBusy(out.queue)).toBe(false);
    expect(shownTask(out.queue)).toMatchObject({ status: "todo", title: "Old title" });
  });

  it("lets a newer pick take the place of an unsent one to the same field, never one in flight", () => {
    let q = startQueue(view());
    q = enqueue(q, setChange(1, "stage", "test")).queue;
    q = send(q).queue;
    q = enqueue(q, setChange(2, "stage", "build")).queue;
    const r = enqueue(q, setChange(3, "stage", "market"));
    expect(r.replaced.map((c) => c.id)).toEqual([2]);
    expect(r.queue.inFlight?.id).toBe(1);
    expect(r.queue.waiting.map((c) => c.id)).toEqual([3]);
    expect(shownTask(r.queue).stage).toBe("market");
  });

  it("builds a second link added before the first is answered on the first, so neither is lost", () => {
    let q = startQueue(view());
    q = enqueue(q, linksChange(1, "typedLinks", [], [PLAN])).queue;
    // The editor draws the links as shown, the first already in.
    const shown = shownTask(q).typedLinks;
    expect(shown).toEqual([PLAN]);
    q = enqueue(q, linksChange(2, "typedLinks", shown, [...shown, PR])).queue;
    const first = send(q);
    expect(first.next).toMatchObject({ body: { typedLinks: [PLAN] } });
    q = answered(first.queue, view({ typedLinks: [PLAN], updatedAt: at(1) }));
    expect(send(q).next).toMatchObject({ body: { typedLinks: [PLAN, PR] }, stamp: at(1) });
    // A link removed comes off the newest list, once.
    expect(listEdit([PLAN, PR, PR], [PLAN, PR])).toEqual({ added: [], removed: [PR] });
    expect(applyListEdit([PR, PLAN, PR], { added: [], removed: [PR] })).toEqual([PLAN, PR]);
  });

  it("chains its own stamps, but keeps an editor's own once someone else's change came in", () => {
    let q = startQueue(view());
    const editorOpened = openedNow(q);
    q = enqueue(q, setChange(1, "status", "in_progress")).queue;
    q = answered(send(q).queue, view({ status: "in_progress", updatedAt: at(1) }));
    // Only the row's own change since: the editor sends the newest stamp.
    expect(stampFor(q, editorOpened)).toBe(at(1));
    // A read of the row's own older stamp is stale, and changes nothing.
    expect(fromServer(q, view({ updatedAt: S0 }))).toBe(q);
    // Someone else's change comes in: a pick builds on it, but the editor keeps the stamp it opened on, and is refused.
    q = fromServer(q, view({ status: "waiting", updatedAt: at(5) }));
    expect(q.epoch).toBe(1);
    expect(shownTask(q).status).toBe("waiting");
    expect(stampFor(q, null)).toBe(at(5));
    expect(stampFor(q, editorOpened)).toBe(S0);
    q = enqueue(q, editorChange(2, "check", { check: null }, editorOpened)).queue;
    expect(send(q).next).toMatchObject({ body: { check: null }, stamp: S0 });
    // An editor opened after it builds on it.
    expect(stampFor(q, openedNow(q))).toBe(at(5));
  });

  it("leaves a read alone while a change is in flight, since it may hold that change before its answer does", () => {
    let q = startQueue(view());
    q = enqueue(q, setChange(1, "mustHave", true)).queue;
    q = send(q).queue;
    expect(fromServer(q, view({ mustHave: true, updatedAt: at(1) }))).toBe(q);
  });

  it("has check taps wait their turn, answering the check as it is then, or nothing once it's gone", () => {
    const check = { kind: "date" as const, at: S0, taskId: null, note: "", setBy: "uid_nina", setAt: "2026-11-20T09:00:00.000Z", which: null };
    let q = startQueue(view({ check, hasCheck: true }));
    q = enqueue(q, setChange(1, "notes", "Called the accountant")).queue;
    q = send(q).queue;
    q = enqueue(q, checkChange(2, { action: "look_again" }, tappedNow(q))).queue;
    q = enqueue(q, checkChange(3, { action: "checked" }, tappedNow(q))).queue;
    expect(nextSend(q)).toBeNull();
    q = answered(q, view({ check, hasCheck: true, notes: "Called the accountant", updatedAt: at(1) }));
    const tap = send(q);
    expect(tap.next).toMatchObject({ skip: false, tap: { action: "look_again" }, setAt: check.setAt });
    const moved = { ...check, at: "2026-11-26T08:00:00.000Z", setAt: at(2) };
    q = answered(tap.queue, view({ check: moved, hasCheck: true, updatedAt: at(2) }));
    // Its own earlier tap moved the check: the next tap answers the check as it is now.
    expect(send(q).next).toMatchObject({ tap: { action: "checked" }, setAt: at(2) });
    // A tap on a check that is gone has nothing to answer.
    const gone = enqueue(startQueue(view()), checkChange(4, { action: "checked" }, { stamp: "", epoch: 0 })).queue;
    expect(send(gone).next).toMatchObject({ skip: true });
  });
});

// --- The list around the open row (pure) ---------------------------------------------------------

describe("the list around the open row", () => {
  it("keeps the open task in the address beside the filters, and drops it on close", () => {
    const f = filtersOf(new URLSearchParams(""));
    expect(openHref(f, 21)).toBe("/admin/work?open=21");
    expect(openHref(f, null)).toBe("/admin/work");
    const must = filtersOf(new URLSearchParams(`brand=${LUMEN_US}&must=1&status=all`));
    expect(openHref(must, 7)).toBe(`/admin/work?brand=${LUMEN_US}&status=all&must=1&open=7`);
    expect(openHref(must, null)).toBe(`/admin/work?brand=${LUMEN_US}&status=all&must=1`);
  });

  it("holds the order for the whole visit: changed rows stay put, new ones go on top, and Sort again shows when anything would move", () => {
    expect(holdOrder(null, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    // b changed, so the server puts it first: it stays where it was.
    const held = holdOrder(["a", "b", "c"], ["b", "a", "c"]);
    expect(held).toEqual(["a", "b", "c"]);
    expect(wouldMove(held, ["b", "a", "c"])).toBe(true);
    // A task just added goes on top; one gone from the server's list goes from the list.
    expect(holdOrder(["a", "b", "c"], ["n", "b", "a"])).toEqual(["n", "a", "b"]);
    expect(wouldMove(["a", "b"], ["a", "b"])).toBe(false);
    // A kept row the server no longer lists doesn't count as moving.
    expect(wouldMove(["k", "a", "b"], ["a", "b"])).toBe(false);
  });

  it("sends focus back to the row's Ref button, or to the next row, the one before, or the list when the task left it", () => {
    expect(focusAfterClose([1, 2, 3], [1, 2, 3], 2)).toEqual({ ref: 2, left: false });
    expect(focusAfterClose([1, 2, 3], [1, 3], 2)).toEqual({ ref: 3, left: true });
    expect(focusAfterClose([1, 2, 3], [1, 2], 3)).toEqual({ ref: 2, left: true });
    expect(focusAfterClose([3], [], 3)).toEqual({ ref: null, left: true });
  });

  it("puts focus on the field of the cell clicked, never a text box", () => {
    expect(cellFocus("ref", { multiBrand: true, due: false })).toEqual({ mark: "heading" });
    expect(cellFocus("title", { multiBrand: true, due: false })).toEqual({ mark: "heading" });
    expect(cellFocus("status", { multiBrand: true, due: false })).toEqual({ mark: "status" });
    expect(cellFocus("stage", { multiBrand: true, due: false })).toEqual({ mark: "stage" });
    expect(cellFocus("brand", { multiBrand: true, due: false })).toEqual({ mark: "brand" });
    expect(cellFocus("brand", { multiBrand: false, due: false })).toEqual({ mark: "heading" });
    expect(cellFocus("must", { multiBrand: true, due: false })).toEqual({ mark: "must" });
    expect(cellFocus("vizzy", { multiBrand: true, due: false })).toEqual({ mark: "vizzy" });
    expect(cellFocus("pr", { multiBrand: true, due: false })).toEqual({ mark: "links" });
    expect(cellFocus("idea", { multiBrand: true, due: false })).toEqual({ mark: "idea" });
    expect(cellFocus("block", { multiBrand: true, due: false })).toEqual({ mark: "block", start: "block" });
    expect(cellFocus("check", { multiBrand: true, due: false })).toEqual({ mark: "check", start: "check" });
    expect(cellFocus("check", { multiBrand: true, due: true })).toEqual({ mark: "check-due" });
    expect(rowCellOf("status")).toBe("status");
    expect(rowCellOf(undefined)).toBe("title");
    expect(rowCellOf("nonsense")).toBe("title");
  });

  it("opens on a plain click, leaves Cmd, Ctrl, shift and middle clicks on a link to the browser, and ignores a click while selecting", () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(clickIntent(click, "", false)).toBe("open");
    expect(clickIntent(click, "", true)).toBe("open");
    expect(clickIntent({ ...click, metaKey: true }, "", true)).toBe("page");
    expect(clickIntent({ ...click, ctrlKey: true }, "", true)).toBe("page");
    expect(clickIntent({ ...click, shiftKey: true }, "", true)).toBe("page");
    expect(clickIntent({ ...click, button: 1 }, "", true)).toBe("page");
    expect(clickIntent(click, "Templates", false)).toBe("ignore");
    expect(clickIntent({ ...click, metaKey: true }, "", false)).toBe("ignore");
    expect(clickIntent({ ...click, button: 2 }, "", false)).toBe("ignore");
  });
});

// --- Leaving the row, Esc and the status line (pure) -----------------------------------------------

describe("leaving the open row", () => {
  const check = { label: "Check", dirty: true, text: false };
  const measure = { label: "How we'll know it worked", dirty: false, text: false };
  const notes = { label: "Notes", dirty: true, text: true };

  it("saves what each text box holds, and asks about the newest editor with unsaved input, never dropping it", () => {
    expect(leaveStep([])).toEqual({ save: [], ask: null });
    expect(leaveStep([notes, measure])).toEqual({ save: [0], ask: null });
    expect(leaveStep([check, notes, { ...measure, dirty: true }])).toEqual({ save: [1], ask: "How we'll know it worked" });
    expect(leaveStep([check])).toEqual({ save: [], ask: "Check" });
  });

  it("closes the innermost thing first on Esc: the question, Delete's confirm, the newest editor (asking when it holds input), then the row", () => {
    expect(escapeStep({ asking: true, confirmingDelete: true, editors: [check] })).toEqual({ kind: "keep" });
    expect(escapeStep({ asking: false, confirmingDelete: true, editors: [check] })).toEqual({ kind: "cancel_delete" });
    expect(escapeStep({ asking: false, confirmingDelete: false, editors: [measure, check] })).toEqual({ kind: "ask", at: 1 });
    expect(escapeStep({ asking: false, confirmingDelete: false, editors: [check, measure] })).toEqual({ kind: "close_editor", at: 1 });
    // A text box takes its own Esc, so it is passed over here.
    expect(escapeStep({ asking: false, confirmingDelete: false, editors: [measure, notes] })).toEqual({ kind: "close_editor", at: 0 });
    expect(escapeStep({ asking: false, confirmingDelete: false, editors: [notes] })).toEqual({ kind: "close_row" });
    expect(escapeStep({ asking: false, confirmingDelete: false, editors: [] })).toEqual({ kind: "close_row" });
  });

  it("says Saved, what Work did besides, or a check's answer, and keeps what Done said through the rest of the burst", () => {
    const words = { saved: "Saved", checked: "Checked." };
    expect(answerLine(null, "patch", null, words)).toBeNull();
    const done = answerLine(null, "patch", "It asks if it worked on 11 Dec at 08:00.", words);
    expect(done).toBe("Saved. It asks if it worked on 11 Dec at 08:00.");
    expect(answerLine(done, "patch", null, words)).toBe(done);
    expect(answerLine(null, "check", "Next check on 28 Nov at 08:00.", words)).toBe("Next check on 28 Nov at 08:00.");
    expect(answerLine(done, "check", null, words)).toBe("Checked.");
  });

  it("says someone else changed the task, keeping typed text in its box or not, or the refusal's own words", () => {
    const words = { changed: "text kept", changedPick: "pick again" };
    expect(refusalLine({ changed: true, keptText: true, message: "x" }, words)).toBe("text kept");
    expect(refusalLine({ changed: true, keptText: false, message: "x" }, words)).toBe("pick again");
    expect(refusalLine({ changed: false, keptText: true, message: "A task keeps up to 20 other links." }, words)).toBe("A task keeps up to 20 other links.");
  });
});
