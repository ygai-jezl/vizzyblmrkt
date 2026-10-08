import { describe, expect, it } from "vitest";
import { dateFactIds, daysSince, daysUntil, dropBadDateFacts, formatFactDate, parseFactDate } from "./dateFacts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 86_400_000;

describe("a date fact's value", () => {
  it("is ISO 8601 with a zone, or a plain day", () => {
    expect(parseFactDate("2026-10-08T09:12:00Z")).toBe(Date.parse("2026-10-08T09:12:00Z"));
    expect(parseFactDate("2026-10-08T10:12:00+01:00")).toBe(Date.parse("2026-10-08T09:12:00Z"));
    expect(parseFactDate("2026-10-08T09:12:00.123Z")).toBe(Date.parse("2026-10-08T09:12:00.123Z"));
    expect(parseFactDate("2026-10-08T09:12Z")).toBe(Date.parse("2026-10-08T09:12:00Z"));
    expect(parseFactDate("2026-10-08")).toBe(Date.parse("2026-10-08T00:00:00Z"));
  });

  it("refuses anything else: a local time, a number, loose text, a day off the calendar", () => {
    for (const bad of ["2026-10-08T09:12:00", "08/10/2026", "yesterday", "", "2026-02-31", "2026-13-01", 1791450000000, true, null, undefined]) {
      expect(parseFactDate(bad)).toBeNull();
    }
  });

  it("reads as whole days from now", () => {
    expect(daysSince(NOW - 14 * DAY, NOW)).toBe(14);
    expect(daysSince(NOW - 14 * DAY + 1, NOW)).toBe(13); // not quite 14 days yet
    expect(daysSince(NOW, NOW)).toBe(0);
    expect(daysSince(NOW + DAY, NOW)).toBe(-1); // still ahead
    expect(daysUntil(NOW + 3 * DAY, NOW)).toBe(3);
    expect(daysUntil(NOW + 2 * DAY + 1, NOW)).toBe(3); // within three days
    expect(daysUntil(NOW - 1, NOW)).toBe(0);
    expect(daysUntil(NOW - DAY, NOW)).toBe(-1);
  });

  it("prints as a long date in the reader's language and time zone; a plain day never shifts", () => {
    expect(formatFactDate("2026-10-08T23:30:00Z", "en-GB", "Europe/London")).toBe("9 October 2026");
    expect(formatFactDate("2026-10-08T23:30:00Z", "en-US", "America/New_York")).toBe("October 8, 2026");
    expect(formatFactDate("2026-10-08", "en-US", "America/Los_Angeles")).toBe("October 8, 2026");
    expect(formatFactDate("2026-10-08T09:00:00Z", "not a locale", "Mars/Olympus")).toBe("8 October 2026");
    expect(formatFactDate("soon", "en-GB", "UTC")).toBeNull();
  });
});

describe("a write with date facts", () => {
  const dates = dateFactIds({ facts: [{ id: "last_active_at", type: "date" }, { id: "share_of_voice", type: "number" }] });

  it("keeps good dates, removals and every other fact", () => {
    const patch = { facts: { last_active_at: "2026-10-08T09:12:00Z", share_of_voice: 12, plan: "pro" }, entities: { b_1: { facts: { last_active_at: null } } } };
    const r = dropBadDateFacts(patch, dates);
    expect(r.dropped).toEqual([]);
    expect(r.patch).toBe(patch);
  });

  it("takes out a date fact that isn't a date, for the person and for an entity, and names each", () => {
    const patch = {
      firstName: "Alex",
      facts: { last_active_at: "last Tuesday", share_of_voice: 12 },
      entities: { b_1: { name: "Fernlight", facts: { last_active_at: 1791450000000 } }, b_2: null },
    };
    const r = dropBadDateFacts(patch, dates);
    expect(r.dropped).toEqual(["facts.last_active_at", "entities.b_1.facts.last_active_at"]);
    expect(r.patch).toEqual({ firstName: "Alex", facts: { share_of_voice: 12 }, entities: { b_1: { name: "Fernlight", facts: {} }, b_2: null } });
  });

  it("does nothing for a catalog with no date facts", () => {
    const patch = { facts: { last_active_at: "last Tuesday" } };
    expect(dropBadDateFacts(patch, dateFactIds({ facts: [] }))).toEqual({ patch, dropped: [] });
  });
});
