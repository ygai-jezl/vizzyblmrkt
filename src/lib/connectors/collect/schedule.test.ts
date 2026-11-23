import { describe, expect, it } from "vitest";
import { advance, EMPTY_CURSOR, keptDays, newestDue, nextAt, nextMidnight, planDays, spreadMs, zonedTime, type CollectCursor } from "./schedule";

const cursor = (over: Partial<CollectCursor> = {}): CollectCursor => ({ ...EMPTY_CURSOR, ...over });
const days = (plan: Array<{ day: string; kind: string }>) => plan.map((p) => `${p.day.slice(5)}:${p.kind[0]}`);

describe("planning a run's days", () => {
  it("starts from the newest day, newest first, at most a slice a run", () => {
    expect(days(planDays(cursor(), "2026-11-20", { keepDays: 90, maxDays: 3 }))).toEqual(["11-20:b", "11-19:b", "11-18:b"]);
  });

  it("collects new days oldest first, then fills backwards until the window is full", () => {
    const c = cursor({ lastDay: "2026-11-18", backfilledTo: "2026-11-15", finalThrough: "2026-11-18" });
    expect(days(planDays(c, "2026-11-20", { keepDays: 90, maxDays: 4 }))).toEqual(["11-19:f", "11-20:f", "11-14:b", "11-13:b"]);
    expect(days(planDays({ ...c, filled: true }, "2026-11-20", { keepDays: 90, maxDays: 4 }))).toEqual(["11-19:f", "11-20:f"]);
  });

  it("reads again days that weren't final, up to the line", () => {
    const c = cursor({ lastDay: "2026-11-20", backfilledTo: "2026-10-01", finalThrough: "2026-11-12", filled: true });
    expect(days(planDays(c, "2026-11-21", { keepDays: 90, maxDays: 6, rereadThrough: "2026-11-15" }))).toEqual(["11-21:f", "11-13:r", "11-14:r", "11-15:r"]);
  });

  it("stops at the provider's reach, and starts again after a gap longer than the keep", () => {
    expect(planDays(cursor(), "2026-11-20", { keepDays: 90, maxDays: 90, reachFrom: "2026-11-18" }).map((p) => p.day)).toEqual(["2026-11-20", "2026-11-19", "2026-11-18"]);
    const stale = cursor({ lastDay: "2026-06-01", backfilledTo: "2026-03-01", filled: true });
    expect(days(planDays(stale, "2026-11-20", { keepDays: 90, maxDays: 2 }))).toEqual(["11-20:b", "11-19:b"]);
  });
});

describe("moving the cursor", () => {
  it("moves only over days that landed with no gap", () => {
    const c = cursor({ lastDay: "2026-11-18", backfilledTo: "2026-11-10", finalThrough: "2026-11-18" });
    const next = advance(c, [{ day: "2026-11-19", final: true }, { day: "2026-11-21", final: true }, { day: "2026-11-09", final: true }], { newest: "2026-11-21", keepDays: 90 });
    expect(next).toMatchObject({ lastDay: "2026-11-19", backfilledTo: "2026-11-09", finalThrough: "2026-11-19", filled: false });
  });

  it("starts from the newest day landed, and is filled once the window or the reach is covered", () => {
    const landed = ["2026-11-20", "2026-11-19", "2026-11-18"].map((day) => ({ day, final: true }));
    expect(advance(EMPTY_CURSOR, landed, { newest: "2026-11-20", keepDays: 90 })).toMatchObject({ lastDay: "2026-11-20", backfilledTo: "2026-11-18", filled: false });
    expect(advance(EMPTY_CURSOR, landed, { newest: "2026-11-20", keepDays: 3 })).toMatchObject({ filled: true });
    expect(advance(EMPTY_CURSOR, landed, { newest: "2026-11-20", keepDays: 90, reachFrom: "2026-11-18" })).toMatchObject({ filled: true });
    expect(keptDays({ lastDay: "2026-11-20", backfilledTo: "2026-11-18" }, 90)).toBe(3);
  });

  it("keeps how far the numbers are final when newer days aren't yet", () => {
    const first = advance(EMPTY_CURSOR, [{ day: "2026-11-21", final: false }, { day: "2026-11-20", final: false }], { newest: "2026-11-21", keepDays: 90 });
    expect(first.finalThrough).toBeNull();
    const later = advance(first, [{ day: "2026-11-19", final: true }, { day: "2026-11-18", final: true }], { newest: "2026-11-21", keepDays: 90 });
    expect(later).toMatchObject({ lastDay: "2026-11-21", backfilledTo: "2026-11-18", finalThrough: "2026-11-19" });
  });
});

describe("when a day is due", () => {
  it("works the day out in the provider's zone, from the hour it is due", () => {
    // 05:00 UTC on 23 Nov: still 22 Nov before 06:00 in London, and 22 Nov in Los Angeles.
    const at = new Date("2026-11-23T05:00:00.000Z");
    expect(newestDue(at, "Europe/London", 2, 6)).toBe("2026-11-20");
    expect(newestDue(new Date("2026-11-23T07:00:00.000Z"), "Europe/London", 2, 6)).toBe("2026-11-21");
    expect(newestDue(at, "UTC", 2, 3)).toBe("2026-11-21");
  });

  it("finds an hour in a zone, in summer and in winter", () => {
    expect(new Date(zonedTime("2026-11-21", 9, "America/Los_Angeles")).toISOString()).toBe("2026-11-21T17:00:00.000Z");
    expect(new Date(zonedTime("2026-07-01", 9, "America/Los_Angeles")).toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(new Date(zonedTime("2026-11-21", 6, "Europe/London")).toISOString()).toBe("2026-11-21T06:00:00.000Z");
    expect(nextMidnight(new Date("2026-11-21T10:00:00.000Z"), "America/Los_Angeles").toISOString()).toBe("2026-11-22T08:00:00.000Z");
  });

  it("spreads connections over the hour, the same way every time", () => {
    const a = spreadMs("dcn_aaaaaaaaaaaaaaaaaaaa");
    expect(a).toBe(spreadMs("dcn_aaaaaaaaaaaaaaaaaaaa"));
    expect(a % 60_000).toBe(0);
    expect(a).toBeLessThan(3_600_000);
    expect(nextAt(new Date("2026-11-21T10:00:00.000Z"), "UTC", 9, a).toISOString()).toBe(new Date(Date.parse("2026-11-22T09:00:00.000Z") + a).toISOString());
    expect(nextAt(new Date("2026-11-21T08:00:00.000Z"), "UTC", 9, 0).toISOString()).toBe("2026-11-21T09:00:00.000Z");
  });
});
