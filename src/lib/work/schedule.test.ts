import { describe, expect, it } from "vitest";
import { checkAfterRead, checkOnDone, dayIn, lookAgain, morningOf, partOf, tomorrowMorning, zoneOf } from "./schedule";
import type { Measure, WorkCheck } from "./types";

const NOW = new Date("2026-11-20T15:00:00.000Z");
const setBy = { setBy: "uid_nina", setAt: "2026-11-01T00:00:00.000Z" };
const used14: Measure = { kind: "used", counts: { productEvent: { connectionId: "pc_lumen", event: "note_from_template" } }, look: { days: 14 }, ...setBy, then: { kind: "moves", meaning: "conversions", direction: "up", word: "Sign ups", look: { days: 60 } } };
const runs7: Measure = { kind: "runs_better", what: "crashes", look: { days: 7 }, ...setBy };
const byOutputs: Measure = { kind: "used", counts: { none: "" }, look: { outputs: 10 }, ...setBy };
const doneWin: Measure = { kind: "done", ...setBy };

describe("08:00 in the brand's time zone", () => {
  it("falls at 08:00 local across zones and summer time, and UTC when the zone is unset or unknown", () => {
    expect(morningOf("2026-12-09", "Europe/London")).toBe("2026-12-09T08:00:00.000Z");
    expect(morningOf("2026-07-09", "Europe/London")).toBe("2026-07-09T07:00:00.000Z");
    expect(morningOf("2026-12-09", "America/New_York")).toBe("2026-12-09T13:00:00.000Z");
    expect(morningOf("2026-12-09", "Asia/Singapore")).toBe("2026-12-09T00:00:00.000Z");
    expect(morningOf("2026-12-09", "Europe/Berlin", "17:30")).toBe("2026-12-09T16:30:00.000Z");
    expect(zoneOf(undefined)).toBe("UTC");
    expect(zoneOf("Not/AZone")).toBe("UTC");
  });

  it("takes tomorrow from the brand's own day, not the server's", () => {
    // 15:00 UTC on 20 Nov is already 21 Nov in Singapore.
    expect(dayIn(NOW, "Asia/Singapore")).toBe("2026-11-20");
    expect(dayIn(new Date("2026-11-20T17:00:00.000Z"), "Asia/Singapore")).toBe("2026-11-21");
    expect(tomorrowMorning(new Date("2026-11-20T17:00:00.000Z"), "Asia/Singapore")).toBe("2026-11-22T00:00:00.000Z");
    expect(tomorrowMorning(NOW, "America/New_York")).toBe("2026-11-21T13:00:00.000Z");
  });
});

describe("the check Done sets", () => {
  it("asks if it worked N days after Done at 08:00 brand time, about the first measure", () => {
    expect(checkOnDone(used14, "2026-11-20T15:00:00.000Z", "Europe/London", NOW)).toEqual({
      kind: "date",
      at: "2026-12-04T08:00:00.000Z",
      taskId: null,
      note: "",
      setBy: "measure",
      setAt: NOW.toISOString(),
      which: "first",
      counted: null,
    });
  });

  it("counts the days from closedAt's own day in the zone", () => {
    // 23:30 in New York on 20 Nov is 04:30 UTC on 21 Nov: still the 20th there.
    expect(checkOnDone(runs7, "2026-11-21T04:30:00.000Z", "America/New_York", NOW)?.at).toBe("2026-11-27T13:00:00.000Z");
  });

  it("sets none for no measure, Done is the win, or a look by outputs", () => {
    expect(checkOnDone(null, NOW.toISOString(), "UTC", NOW)).toBeNull();
    expect(checkOnDone(doneWin, NOW.toISOString(), "UTC", NOW)).toBeNull();
    expect(checkOnDone(byOutputs, NOW.toISOString(), "UTC", NOW)).toBeNull();
  });
});

describe("the check after a read", () => {
  const first = checkOnDone(used14, "2026-11-20T15:00:00.000Z", "Europe/London", NOW)!;
  const ctx = { measure: used14, closedAt: "2026-11-20T15:00:00.000Z", timeZone: "Europe/London" };

  it("Better, Same or Worse on the first sets the then's check at closedAt plus the then's days", () => {
    for (const read of ["better", "same", "worse"] as const) {
      const next = checkAfterRead(first, read, { ...ctx, now: new Date("2026-12-04T09:00:00.000Z") });
      expect(next).toMatchObject({ which: "then", setBy: "measure", at: "2027-01-19T08:00:00.000Z", counted: null });
    }
  });

  it("sets the then's check now when its day has passed", () => {
    const late = new Date("2027-02-01T10:00:00.000Z");
    expect(checkAfterRead(first, "same", { ...ctx, now: late })?.at).toBe(late.toISOString());
  });

  it("Too soon to tell asks the same measure again 7 days on at 08:00, or on the day picked, with no then's check", () => {
    const now = new Date("2026-12-04T09:00:00.000Z");
    expect(checkAfterRead(first, "too_soon", { ...ctx, now })).toMatchObject({ which: "first", at: "2026-12-11T08:00:00.000Z", counted: null });
    expect(checkAfterRead(first, "too_soon", { ...ctx, now, day: "2026-12-20", time: "10:00" })).toMatchObject({ which: "first", at: "2026-12-20T10:00:00.000Z" });
    const thenCheck: WorkCheck = { ...first, which: "then" };
    expect(checkAfterRead(thenCheck, "too_soon", { ...ctx, now })?.which).toBe("then");
  });

  it("ends the check on the then, with no then, or a then that looks by outputs", () => {
    const now = new Date("2026-12-04T09:00:00.000Z");
    expect(checkAfterRead({ ...first, which: "then" }, "better", { ...ctx, now })).toBeNull();
    expect(checkAfterRead(first, "worse", { ...ctx, measure: runs7, now })).toBeNull();
    const thenByOutputs: Measure = { ...used14, then: { kind: "runs_better", what: "errors", look: { outputs: 20 } } } as Measure;
    expect(checkAfterRead(first, "same", { ...ctx, measure: thenByOutputs, now })).toBeNull();
  });

  it("knows which part a check asks about", () => {
    expect(partOf(used14, "first")?.kind).toBe("used");
    expect(partOf(used14, "then")?.kind).toBe("moves");
    expect(partOf(runs7, "then")).toBeNull();
    expect(partOf(doneWin, "first")).toBeNull();
    expect(partOf(used14, null)).toBeNull();
  });
});

describe("look again", () => {
  const dateCheck: WorkCheck = { kind: "date", at: "2026-11-20T08:00:00.000Z", taskId: null, note: "Call the auditor", setBy: "uid_sam", setAt: "2026-11-01T00:00:00.000Z", which: null, counted: null };

  it("moves a date check to tomorrow at 08:00 by default, or the day and time picked, set by the person", () => {
    expect(lookAgain(dateCheck, { by: "uid_nina", timeZone: "Europe/London", now: NOW })).toMatchObject({ at: "2026-11-21T08:00:00.000Z", setBy: "uid_nina", note: "Call the auditor", which: null });
    expect(lookAgain(dateCheck, { by: "uid_nina", timeZone: "Europe/London", now: NOW, day: "2026-11-25", time: "14:00" }).at).toBe("2026-11-25T14:00:00.000Z");
  });

  it("turns a check that waited for a task into a date check, and keeps a measure's check asking about its measure", () => {
    const after: WorkCheck = { ...dateCheck, kind: "after_task", at: null, taskId: "wt_aaaaaaaaaaaaaaaaaaab" };
    expect(lookAgain(after, { by: "uid_nina", timeZone: "UTC", now: NOW })).toMatchObject({ kind: "date", taskId: null, at: "2026-11-21T08:00:00.000Z" });
    const m = checkOnDone(used14, NOW.toISOString(), "UTC", NOW)!;
    expect(lookAgain({ ...m, counted: { n: 3, from: "x", to: "y", at: "z" } }, { by: "uid_nina", timeZone: "UTC", now: NOW })).toMatchObject({ setBy: "measure", which: "first", counted: null });
  });
});
