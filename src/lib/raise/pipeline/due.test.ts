import { describe, expect, it } from "vitest";
import { todayFor } from "./board";
import { daysBetween, dueReasons, dueTallies, isNextStepPast, isQuiet, QUIET_AFTER_DAYS, quietDays } from "./due";

const TODAY = "2026-11-26";

describe("the follow-up rule", () => {
  it("is quiet from 14 days after the Last touch, not 13", () => {
    expect(QUIET_AFTER_DAYS).toBe(14);
    expect(isQuiet("active", "2026-11-12", TODAY)).toBe(true);
    expect(isQuiet("active", "2026-11-13", TODAY)).toBe(false);
    expect(isQuiet("active", "2026-10-01", TODAY)).toBe(true);
  });

  it("is never quiet with no Last touch, or a value that isn't a day", () => {
    expect(isQuiet("active", null, TODAY)).toBe(false);
    expect(isQuiet("active", undefined, TODAY)).toBe(false);
    expect(isQuiet("active", "last week", TODAY)).toBe(false);
    expect(quietDays(null, TODAY)).toBeNull();
    expect(quietDays("2026-11-10", TODAY)).toBe(16);
  });

  it("is past the next step from the day after its date", () => {
    expect(isNextStepPast("active", "2026-11-25", TODAY)).toBe(true);
    expect(isNextStepPast("active", TODAY, TODAY)).toBe(false);
    expect(isNextStepPast("active", "2026-12-03", TODAY)).toBe(false);
    expect(isNextStepPast("active", null, TODAY)).toBe(false);
  });

  it("lets the stage's role decide: quiet only in play, next step before money in or passed", () => {
    expect(isQuiet("open", "2026-10-01", TODAY)).toBe(false);
    expect(isQuiet("won", "2026-10-01", TODAY)).toBe(false);
    expect(isQuiet("passed", "2026-10-01", TODAY)).toBe(false);
    expect(isNextStepPast("open", "2026-11-01", TODAY)).toBe(true);
    expect(isNextStepPast("won", "2026-11-01", TODAY)).toBe(false);
    expect(isNextStepPast("passed", "2026-11-01", TODAY)).toBe(false);
    expect(dueReasons({ lastTouch: "2026-10-01", nextStepDate: "2026-11-01" }, "active", TODAY)).toEqual(["quiet", "next_step"]);
    expect(dueReasons({ lastTouch: "2026-10-01", nextStepDate: "2026-11-01" }, "open", TODAY)).toEqual(["next_step"]);
  });

  it("counts each person once when overdue both ways", () => {
    expect(dueTallies([{ due: ["quiet", "next_step"] }, { due: ["quiet"] }, { due: [] }, { due: ["next_step"] }])).toEqual({ quiet: 2, nextStepPast: 2, overdue: 3 });
  });

  it("counts days in the brand's own time zone: late evening in London is the next day in Auckland", () => {
    const now = new Date("2026-11-26T20:00:00.000Z");
    expect(todayFor("Europe/London", now)).toBe("2026-11-26");
    expect(todayFor("Pacific/Auckland", now)).toBe("2026-11-27");
    expect(todayFor(null, now)).toBe("2026-11-26");
    expect(todayFor("Not/AZone", now)).toBe("2026-11-26");
    // The same Last touch is quiet a day sooner in Auckland.
    expect(isQuiet("active", "2026-11-13", todayFor("Pacific/Auckland", now))).toBe(true);
    expect(isQuiet("active", "2026-11-13", todayFor("Europe/London", now))).toBe(false);
    expect(daysBetween("2026-11-13", "2026-11-27")).toBe(14);
  });
});
