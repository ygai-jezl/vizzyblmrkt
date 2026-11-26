import { describe, expect, it } from "vitest";
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
    expect(oldFigureYears("In 2023, 38% of buyers asked first. By 2025 it was 45%, and in 2026 52%.", NOW)).toEqual([2023]);
  });

  it("counts a year as an old figure only where a sentence states a figure from it, outside citations", () => {
    // Live, 26 Nov 2026: seven articles went due for "A figure from 2024" that only cited 2024 sources.
    const cited = [
      "AI Overviews took 34.5% of clicks [Ahrefs, 2024](https://example.com/2024/05/25/study).",
      "Clicks fell 38% (Search Engine Journal, 2024).",
      "## Sources",
      "- [AI Overviews study](https://example.com/study) \u2014 Advanced Web Ranking, 2024",
      "- Semrush study of 10,000 pages, Semrush, 2024",
    ].join("\n");
    expect(oldFigureYears(cited, NOW)).toEqual([]);
    // History and dates name a year without stating a figure from it.
    expect(oldFigureYears("The site carried placeholder dates from 2024 before the brand existed.", NOW)).toEqual([]);
    expect(oldFigureYears("We removed the 2024 placeholder dates on 23 June, and on June 23rd the sitemap.", NOW)).toEqual([]);
    // A figure stated from an old year still counts, cited or not.
    expect(oldFigureYears("For mobile websites in 2024, the Web Almanac recorded that 42% had good scores [HTTP Archive, 2025](https://example.com).", NOW)).toEqual([2024]);
    expect(oldFigureYears("Last year 61% of teams agreed, up from 40% in 2023 and 35% in 2022.", NOW)).toEqual([2022, 2023]);
  });
});
