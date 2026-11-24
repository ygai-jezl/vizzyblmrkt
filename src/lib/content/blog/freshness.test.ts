import { describe, expect, it } from "vitest";
import { articleFigures } from "./figures";
import { articleFreshness, assignClock, nextEvents, oldFigureYears } from "./freshness";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const base = { publishedAt: "2026-10-20", updatedAt: null, checkedAt: null, clockDays: 30 as const, signals: [] };

describe("article freshness", () => {
  it("gives a fixed clock as set, and in the test the clock a subject has fewest of", () => {
    expect(assignClock(45, { 20: 0, 30: 0, 45: 9 })).toEqual({ clockDays: 45, arm: "fixed" });
    expect(assignClock(undefined, { 20: 2, 30: 1, 45: 2 })).toEqual({ clockDays: 30, arm: "test" });
    expect(assignClock("test", { 20: 1, 30: 1, 45: 0 })).toEqual({ clockDays: 45, arm: "test" });
    // Ties are broken at random.
    expect(assignClock("test", {}, () => 0).clockDays).toBe(20);
    expect(assignClock("test", {}, () => 0.99).clockDays).toBe(45);
  });

  it("is fresh inside its clock, soon in its last 5 days, and due past it", () => {
    expect(articleFreshness(base, new Date("2026-11-10T00:00:00Z"))).toMatchObject({ state: "fresh", reasons: [], dueAt: "2026-11-19T00:00:00.000Z" });
    expect(articleFreshness(base, new Date("2026-11-15T00:00:00Z"))?.state).toBe("soon");
    const due = articleFreshness(base, NOW)!;
    expect(due.state).toBe("due");
    expect(due.reasons).toEqual([{ kind: "age", detail: "35 days since its last update or check, on a 30-day clock", hard: true }]);
  });

  it("counts from the latest of Published, Updated and a check, so a check resets the clock without Updated", () => {
    expect(articleFreshness({ ...base, updatedAt: "2026-11-10T09:00:00Z" }, NOW)?.state).toBe("fresh");
    const checked = articleFreshness({ ...base, checkedAt: "2026-11-23T08:00:00.000Z" }, NOW)!;
    expect(checked).toMatchObject({ state: "fresh", dueAt: "2026-12-23T08:00:00.000Z" });
  });

  it("is due sooner for a hard reason, soon for a soft one, and has no clock until it is live", () => {
    const hard = { kind: "losing_clicks" as const, detail: "38% fewer clicks in 28 days", hard: true };
    const soft = { kind: "old_source" as const, detail: "Cites a source from 2023", hard: false };
    expect(articleFreshness({ ...base, signals: [hard] }, new Date("2026-11-01T00:00:00Z"))).toMatchObject({ state: "due", reasons: [hard] });
    expect(articleFreshness({ ...base, signals: [soft] }, new Date("2026-11-01T00:00:00Z"))).toMatchObject({ state: "soon", reasons: [soft] });
    expect(articleFreshness({ ...base, publishedAt: null }, NOW)).toBeNull();
  });

  it("keeps the last 20 events, and finds figures two or more years old", () => {
    let events: Parameters<typeof nextEvents>[0] = [];
    for (let i = 0; i < 25; i += 1) events = nextEvents(events, { at: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`, kind: "checked", clockDays: 30 });
    expect(events).toHaveLength(20);
    expect(events[0]!.at).toBe("2026-11-06");
    const figures = articleFigures("In 2023, 38% of buyers asked first. By 2025 it was 45%, and in 2026 52%.").map((f) => f.display);
    expect(oldFigureYears(figures, NOW)).toEqual([2023]);
  });
});
