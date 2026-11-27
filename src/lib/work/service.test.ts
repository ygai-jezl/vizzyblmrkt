import { describe, expect, it } from "vitest";
import { isCheckDue, isReadyToStart, readyOrder, type TaskLookup } from "./service";
import { aStoredTask, NINA, T0 } from "./testing/fixtures";
import type { WorkCheck } from "./types";

const NOW = new Date("2026-11-21T08:00:00.000Z");
const BLOCKER = "wt_aaaaaaaaaaaaaaaaaazz";
const dateCheck = (at: string): WorkCheck => ({ kind: "date", at, taskId: null, note: "", setBy: NINA, setAt: T0, which: null });
const afterCheck = (taskId = BLOCKER): WorkCheck => ({ kind: "after_task", at: null, taskId, note: "", setBy: NINA, setAt: T0, which: null });
const lookup =
  (s: ReturnType<TaskLookup>): TaskLookup =>
  () =>
    s;

describe("a check comes due (work_check_due)", () => {
  it("on its date, and not before", () => {
    expect(isCheckDue({ check: dateCheck("2026-11-21T08:00:00.000Z") }, NOW)).toBe(true);
    expect(isCheckDue({ check: dateCheck("2026-11-21T08:00:00.001Z") }, NOW)).toBe(false);
    expect(isCheckDue({ check: dateCheck(T0) }, NOW)).toBe(true);
    expect(isCheckDue({ check: null }, NOW)).toBe(false);
  });

  it("once the task it waits for is Done, Dropped or gone, never on a task it couldn't read", () => {
    expect(isCheckDue({ check: afterCheck() }, NOW, lookup("done"))).toBe(true);
    expect(isCheckDue({ check: afterCheck() }, NOW, lookup("dropped"))).toBe(true);
    expect(isCheckDue({ check: afterCheck() }, NOW, lookup("gone"))).toBe(true);
    expect(isCheckDue({ check: afterCheck() }, NOW, lookup("in_progress"))).toBe(false);
    expect(isCheckDue({ check: afterCheck() }, NOW, lookup(undefined))).toBe(false);
  });
});

describe("ready to start (work_ready)", () => {
  it("is a To do task with nothing in its way", () => {
    expect(isReadyToStart(aStoredTask(), NOW)).toBe(true);
    expect(isReadyToStart(aStoredTask({ status: "in_progress" }), NOW)).toBe(false);
    expect(isReadyToStart(aStoredTask({ waitingOn: "the supplier's quote" }), NOW)).toBe(false);
    expect(isReadyToStart(aStoredTask({ blockedBy: [BLOCKER] }), NOW, lookup("todo"))).toBe(false);
    expect(isReadyToStart(aStoredTask({ blockedBy: [BLOCKER] }), NOW, lookup(undefined))).toBe(false);
    expect(isReadyToStart(aStoredTask({ blockedBy: [BLOCKER] }), NOW, lookup("done"))).toBe(true);
    expect(isReadyToStart(aStoredTask({ check: dateCheck("2026-12-09T08:00:00.000Z"), hasCheck: true }), NOW)).toBe(false);
    expect(isReadyToStart(aStoredTask({ check: dateCheck(T0), hasCheck: true }), NOW)).toBe(true);
    expect(isReadyToStart(aStoredTask({ check: afterCheck(), hasCheck: true }), NOW, lookup("done"))).toBe(true);
  });

  it("is ordered Must have first, then by stage (none last), then by ref", () => {
    const tasks = [
      aStoredTask({ ref: 5, stage: null }),
      aStoredTask({ ref: 4, stage: "market" }),
      aStoredTask({ ref: 9, stage: "set_up" }),
      aStoredTask({ ref: 7, stage: "improve", mustHave: true }),
      aStoredTask({ ref: 2, stage: "market" }),
    ];
    expect([...tasks].sort(readyOrder).map((t) => t.ref)).toEqual([7, 9, 2, 4, 5]);
  });
});
