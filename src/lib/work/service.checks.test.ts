import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_LOG, WORK_TASKS } from "@/lib/tenant";
import { actOnCheck, addTask, editTask, listTasks, taskPage } from "./service";
import { filtersOf, type MeasureInput } from "./inputs";
import type { WorkResult } from "./result";
import { makeWorld, PEOPLE, type World } from "./testing/world";
import { LUMEN_US } from "./testing/fixtures";
import type { TenantContext } from "@/lib/tenant/types";
import type { WorkLogRow, WorkLogRowOf, WorkTask } from "./types";

// Checks and the one tap read. Lumen Notes is in New York time (08:00 is 13:00 UTC in winter).
let w: World;
beforeEach(() => {
  w = makeWorld("2026-11-20T15:00:00.000Z");
});
afterEach(() => vi.unstubAllEnvs());

function value<T>(r: WorkResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${r.error} ${JSON.stringify(r.issues ?? [])}`);
  return r.value;
}
const nina = () => w.scope(PEOPLE.nina);
const add = async (body: Parameters<typeof addTask>[1], who: TenantContext = PEOPLE.nina) => value(await addTask(await w.scope(who), body, w.deps));
const edit = async (ref: number, body: Parameters<typeof editTask>[2]) => editTask(await nina(), ref, body, w.deps);
const act = async (body: Parameters<typeof actOnCheck>[1], who: TenantContext = PEOPLE.nina) => actOnCheck(await w.scope(who), body, w.deps);
const stored = (t: WorkTask) => w.us.raw(WORK_TASKS, t.id)!;
const logRows = () => w.us.dump(WORK_LOG) as unknown as WorkLogRow[];
const checkRows = () => logRows().filter((r): r is WorkLogRowOf<"check"> => r.kind === "check");

const usedThenMoves: MeasureInput = {
  kind: "used",
  counts: { productEvent: { connectionId: "pc_lumen", event: "note_from_template" } },
  look: { days: 7 },
  then: { kind: "moves", meaning: "conversions", word: "Sign ups", look: { days: 30 } },
};

function connectProduct() {
  w.us.seed("product_connections", "pc_lumen", { tenantId: LUMEN_US, name: "Lumen app", status: "active" });
}

describe("Done on a measure", () => {
  it("sets the measure's check N days on at 08:00 brand time, asking if it worked, and keeps the task open until it is read", async () => {
    connectProduct();
    const t = await add({ title: "Suggest an angle", brandId: LUMEN_US, measure: usedThenMoves });
    w.at("2026-11-20T18:00:00.000Z");
    const r = value(await edit(t.task.task.ref, { status: "done" }));
    expect(r.task.task).toMatchObject({ status: "done", open: true, closedAt: "2026-11-20T18:00:00.000Z", hasCheck: true });
    expect(r.task.task.check).toMatchObject({ kind: "date", at: "2026-11-27T13:00:00.000Z", setBy: "measure", which: "first", counted: null });
    expect(r.notice).toBe("It asks if it worked on 27 Nov at 08:00.");
  });

  it("replaces an open check, and says so", async () => {
    const t = await add({ title: "Fix the sync crash", brandId: LUMEN_US, measure: { kind: "runs_better", what: "crashes", look: { days: 14 } }, check: { kind: "date", day: "2026-12-24" } });
    const r = value(await edit(t.task.task.ref, { status: "done" }));
    expect(r.task.task.check).toMatchObject({ setBy: "measure", at: "2026-12-04T13:00:00.000Z" });
    expect(r.notice).toBe("It asks if it worked on 4 Dec at 08:00, in place of the check that was set.");
  });

  it("sets no check for Done is the win or a look by outputs, and the task closes", async () => {
    const win = await add({ title: "Register the company", brandId: LUMEN_US, measure: { kind: "done" } });
    const outputs = await add({ title: "More angles", brandId: LUMEN_US, measure: { kind: "used", counts: { none: "" }, look: { outputs: 10 } } });
    for (const t of [win, outputs]) {
      const r = value(await edit(t.task.task.ref, { status: "done" }));
      expect(r.task.task).toMatchObject({ check: null, hasCheck: false, open: false });
      expect(r.notice).toBeNull();
    }
  });

  it("clears the measure's check when the task is opened again or dropped", async () => {
    const t = await add({ title: "Fix the sync crash", brandId: LUMEN_US, measure: { kind: "runs_better", what: "crashes", look: { days: 7 } } });
    await edit(t.task.task.ref, { status: "done" });
    expect(value(await edit(t.task.task.ref, { status: "in_progress" })).task.task).toMatchObject({ check: null, closedAt: null, open: true });
    await edit(t.task.task.ref, { status: "done" });
    expect(value(await edit(t.task.task.ref, { status: "dropped" })).task.task).toMatchObject({ check: null, open: false });
  });

  it("keeps a measure's check out of a person's own check: refused until it is read", async () => {
    const t = await add({ title: "Fix the sync crash", brandId: LUMEN_US, measure: { kind: "runs_better", what: "crashes", look: { days: 7 } }, status: "done" });
    expect(await edit(t.task.task.ref, { check: { kind: "date", day: "2026-12-01" } })).toMatchObject({ ok: false, error: "measure_check_kept" });
    expect(await edit(t.task.task.ref, { check: null })).toMatchObject({ ok: false, error: "measure_check_kept" });
  });
});

describe("the one tap read", () => {
  async function dueTask() {
    connectProduct();
    const t = await add({ title: "Suggest an angle", brandId: LUMEN_US, measure: usedThenMoves, status: "done" });
    w.at("2026-11-27T14:00:00.000Z");
    return t.task.task;
  }

  it("Better, Same or Worse on the first measure sets the then's check, at closedAt plus the then's days, with the read on its row", async () => {
    const t = await dueTask();
    const r = value(await act({ ref: t.ref, action: "read", read: "better" }));
    expect(r.task.task.check).toMatchObject({ which: "then", setBy: "measure", at: "2026-12-20T13:00:00.000Z" });
    expect(r.task.task.open).toBe(true);
    expect(r.notice).toBe("The then's check is on 20 Dec at 08:00.");
    expect(checkRows()).toEqual([
      expect.objectContaining({ kind: "check", taskId: t.id, check: expect.objectContaining({ action: "read", read: "better", measureKind: "used", which: "first", next: "2026-12-20T13:00:00.000Z", counted: expect.objectContaining({ n: 0 }) }) }),
    ]);
  });

  it("a read on the then ends the check, and the Done task closes", async () => {
    const t = await dueTask();
    await act({ ref: t.ref, action: "read", read: "same" });
    w.at("2026-12-21T14:00:00.000Z");
    const r = value(await act({ ref: t.ref, action: "read", read: "worse" }));
    expect(r.task.task).toMatchObject({ check: null, hasCheck: false, open: false, status: "done" });
    expect(checkRows().map((x) => [x.check.which, x.check.measureKind, x.check.read])).toEqual([
      ["first", "used", "same"],
      ["then", "moves", "worse"],
    ]);
  });

  it("Too soon to tell asks the same measure again 7 days on, with no then's check, so the read stays possible", async () => {
    const t = await dueTask();
    const r = value(await act({ ref: t.ref, action: "read", read: "too_soon" }));
    expect(r.task.task.check).toMatchObject({ which: "first", setBy: "measure", at: "2026-12-04T13:00:00.000Z", counted: null });
    expect(r.notice).toBe("It asks again on 4 Dec at 08:00.");
    // The person can change the day.
    const later = value(await act({ ref: t.ref, action: "look_again", day: "2026-12-10" }));
    expect(later.task.task.check).toMatchObject({ which: "first", setBy: "measure", at: "2026-12-10T13:00:00.000Z" });
    w.at("2026-12-10T14:00:00.000Z");
    expect(value(await act({ ref: t.ref, action: "read", read: "better" })).task.task.check?.which).toBe("then");
  });

  it("is taken only on a measure's check, and a measure's check takes a read, not Mark checked", async () => {
    const t = await dueTask();
    expect(await act({ ref: t.ref, action: "checked" })).toMatchObject({ ok: false, status: 409, error: "measure_check_read" });
    const dated = await add({ title: "Call the auditor", brandId: LUMEN_US, check: { kind: "date", day: "2026-11-27" } });
    expect(await act({ ref: dated.task.task.ref, action: "read", read: "better" })).toMatchObject({ ok: false, error: "read_not_measure" });
    const win = await add({ title: "Register the company", brandId: LUMEN_US, measure: { kind: "done" }, status: "done", check: { kind: "date", day: "2026-11-27" } });
    expect(await act({ ref: win.task.task.ref, action: "read", read: "better" })).toMatchObject({ ok: false, error: "read_not_measure" });
    const none = await add({ title: "Nothing to check", brandId: LUMEN_US });
    expect(await act({ ref: none.task.task.ref, action: "checked" })).toMatchObject({ ok: false, error: "no_check" });
  });

  it("counts a due measure's check once when it shows, and keeps the count on it", async () => {
    const t = await dueTask();
    for (let i = 0; i < 3; i++) {
      w.us.seed("product_events", `pe_${i}`, { tenantId: LUMEN_US, connectionId: "pc_lumen", type: "track", event: "note_from_template", receivedAt: `2026-11-2${2 + i}T12:00:00.000Z` });
    }
    const page = value(await taskPage(await nina(), t.ref, w.deps));
    expect(page.task.check?.counted).toMatchObject({ n: 3, from: t.closedAt, to: "2026-11-27T13:00:00.000Z" });
    expect(page.checkLine).toBe("Work counted 3 note_from_template events from Lumen Notes' product since 20 Nov.");
    w.us.seed("product_events", "pe_late", { tenantId: LUMEN_US, connectionId: "pc_lumen", type: "track", event: "note_from_template", receivedAt: "2026-11-26T12:00:00.000Z" });
    expect(value(await taskPage(await nina(), t.ref, w.deps)).task.check?.counted?.n).toBe(3);
    const counts = logRows().filter((r) => r.source.tool === "work_count");
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ kind: "change", field: "check", source: { who: { kind: "system", id: null } } });
  });

  it("says what Work can't count, in the brand's word", async () => {
    const t = await add({ title: "Market stall", brandId: LUMEN_US, measure: { kind: "moves", meaning: "conversions", word: "Orders", look: { days: 7 } }, status: "done" });
    w.at("2026-11-28T14:00:00.000Z");
    expect(value(await taskPage(await nina(), t.task.task.ref, w.deps)).checkLine).toBe("Work can't count orders for Lumen Notes yet, so your read is the record.");
  });
});

describe("date and task checks", () => {
  it("Mark checked ends a date check; Look again moves it to tomorrow at 08:00, or the day and time picked", async () => {
    const t = await add({ title: "Call the auditor", brandId: LUMEN_US, check: { kind: "date", day: "2026-11-20", note: "Ask about Type 1" } });
    const again = value(await act({ ref: t.task.task.ref, action: "look_again", via: "review_check" }));
    expect(again.task.task.check).toMatchObject({ at: "2026-11-21T13:00:00.000Z", note: "Ask about Type 1", setBy: PEOPLE.nina.userId });
    expect(again.notice).toBe("Next check on 21 Nov at 08:00.");
    const picked = value(await act({ ref: t.task.task.ref, action: "look_again", day: "2026-11-24", time: "16:30" }));
    expect(picked.task.task.check?.at).toBe("2026-11-24T21:30:00.000Z");
    const done = value(await act({ ref: t.task.task.ref, action: "checked" }));
    expect(done.task.task).toMatchObject({ check: null, hasCheck: false });
    expect(checkRows().map((r) => [r.check.action, r.check.read, r.check.measureKind, r.source.tool])).toEqual([
      ["look_again", null, null, "review_check"],
      ["look_again", null, null, "work_page"],
      ["checked", null, null, "work_page"],
    ]);
  });

  it("comes due on a task check once the task it waits for is done, and shows first in the list", async () => {
    const first = await add({ title: "Pricing page", brandId: LUMEN_US });
    const after = await add({ title: "List on G2", brandId: LUMEN_US, check: { kind: "after_task", ref: first.task.task.ref } });
    const listed = async () => value(await listTasks(await nina(), filtersOf(new URLSearchParams()), w.deps)).tasks.map((v) => [v.task.ref, v.due]);
    expect(await listed()).toEqual([
      [2, false],
      [1, false],
    ]);
    await edit(first.task.task.ref, { status: "done" });
    expect(await listed()).toEqual([[2, true]]);
    expect(value(await taskPage(await nina(), after.task.task.ref, w.deps)).checkTask).toEqual({ id: first.task.task.id, ref: 1, title: "Pricing page", status: "done" });
    expect(await addTask(await nina(), { title: "Waits on nothing", check: { kind: "after_task", ref: 77 } }, w.deps)).toMatchObject({ ok: false, error: "check_task_missing" });
  });

  it("comes due at 08:00 in each brand's own time zone", async () => {
    // Lumen Notes is New York (13:00 UTC), Lumen Europe Berlin (07:00 UTC), Hearth Bakery Singapore (00:00 UTC).
    const ny = await add({ title: "New York's", brandId: LUMEN_US, check: { kind: "date", day: "2026-11-23" } });
    const berlin = await add({ title: "Berlin's", brandId: "ten_lumen-eu", check: { kind: "date", day: "2026-11-23" } });
    const sg = await add({ title: "Singapore's", check: { kind: "date", day: "2026-11-23" } }, PEOPLE.hal);
    expect([ny, berlin, sg].map((t) => t.task.task.check?.at)).toEqual(["2026-11-23T13:00:00.000Z", "2026-11-23T07:00:00.000Z", "2026-11-23T00:00:00.000Z"]);
    const due = async (who: TenantContext) => value(await listTasks(await w.scope(who), filtersOf(new URLSearchParams("due=1")), w.deps)).tasks.map((v) => v.task.title);
    w.at("2026-11-23T06:59:00.000Z");
    expect(await due(PEOPLE.nina)).toEqual([]);
    expect(await due(PEOPLE.hal)).toEqual(["Singapore's"]);
    w.at("2026-11-23T07:00:00.000Z");
    expect(await due(PEOPLE.nina)).toEqual(["Berlin's"]);
    w.at("2026-11-23T13:00:00.000Z");
    expect((await due(PEOPLE.nina)).sort()).toEqual(["Berlin's", "New York's"]);
  });

  it("keeps a Done task with a person's check due in the checks due filter, not in Open", async () => {
    const t = await add({ title: "Tell the team", brandId: LUMEN_US, status: "done", check: { kind: "date", day: "2026-11-20" } });
    expect(stored(t.task.task)).toMatchObject({ open: false, hasCheck: true });
    const l = value(await listTasks(await nina(), filtersOf(new URLSearchParams("due=1")), w.deps));
    expect(l.tasks.map((v) => v.task.id)).toEqual([t.task.task.id]);
    expect(value(await listTasks(await nina(), filtersOf(new URLSearchParams()), w.deps)).tasks).toEqual([]);
  });
});
