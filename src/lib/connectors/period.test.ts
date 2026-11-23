import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { addDays, cappedNote, daysIn, daysWords, isDay, isTimeZone, nothingYetNote, periodWords, rangeWords, resolveWindow, todayIn, zoneWords } from "./period";

describe("days in a time zone", () => {
  it("works out today in the provider's zone, not the server's", () => {
    // 05:00 UTC on 22 Nov is still 21 Nov in Pacific time (PST, UTC minus 8).
    expect(todayIn(new Date("2026-11-22T05:00:00Z"), "America/Los_Angeles")).toBe("2026-11-21");
    expect(todayIn(new Date("2026-11-22T05:00:00Z"), "UTC")).toBe("2026-11-22");
    expect(todayIn(new Date("2026-11-22T20:00:00Z"), "Asia/Tokyo")).toBe("2026-11-23");
  });

  it("counts and moves days, and knows a real day and zone", () => {
    expect(addDays("2026-11-20", -27)).toBe("2026-10-24");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysIn("2026-10-24", "2026-11-20")).toBe(28);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-11-20")).toBe(true);
    expect(isTimeZone("Europe/London")).toBe(true);
    expect(isTimeZone("Not/AZone")).toBe(false);
  });
});

describe("a read's window", () => {
  it("ends a named period on the provider's last complete day", () => {
    expect(resolveWindow({ period: "last_28_days" }, "2026-11-20")).toEqual({ from: "2026-10-24", to: "2026-11-20", capped: false, empty: false });
    expect(resolveWindow({ period: "yesterday" }, "2026-11-20")).toEqual({ from: "2026-11-20", to: "2026-11-20", capped: false, empty: false });
  });

  it("caps explicit days at the last complete day, or reads nothing when none is complete", () => {
    expect(resolveWindow({ from: "2026-11-01", to: "2026-11-10" }, "2026-11-20")).toMatchObject({ to: "2026-11-10", capped: false });
    expect(resolveWindow({ from: "2026-11-01", to: "2026-11-22" }, "2026-11-20")).toEqual({ from: "2026-11-01", to: "2026-11-20", capped: true, empty: false });
    expect(resolveWindow({ from: "2026-11-21", to: "2026-11-22" }, "2026-11-20")).toMatchObject({ capped: true, empty: true });
  });
});

describe("period words", () => {
  it("says the days and zone plainly", () => {
    expect(periodWords({ from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles" })).toBe("24 Oct to 20 Nov 2026, Pacific time");
    expect(periodWords({ from: "2026-11-20", to: "2026-11-20", timeZone: "UTC" })).toBe("20 Nov 2026, UTC");
    expect(periodWords({ from: "2026-12-28", to: "2027-01-03", timeZone: "Europe/Berlin" })).toBe("28 Dec 2026 to 3 Jan 2027, Central European time");
    expect(periodWords({ from: "2026-11-01", to: "2026-11-07", timeZone: null })).toBe("1 Nov to 7 Nov 2026, the property's time zone");
    expect(rangeWords("2026-11-01", "2026-11-07")).toBe("1 Nov to 7 Nov 2026");
    expect(zoneWords("Europe/London")).toBe("United Kingdom time");
  });

  it("dates notes without the year", () => {
    expect(daysWords("2026-11-21", "2026-11-21")).toBe("21 Nov");
    expect(daysWords("2026-11-20", "2026-11-21")).toBe("20 and 21 Nov");
    expect(daysWords("2026-11-18", "2026-11-21")).toBe("18 to 21 Nov");
    expect(daysWords("2026-11-30", "2026-12-01")).toBe("30 Nov and 1 Dec");
    expect(cappedNote("Cloudflare", "2026-11-22")).toBe("The last complete day in Cloudflare is 22 Nov, so this read ends there.");
    expect(nothingYetNote("Search Console", "2026-11-22", "2026-11-22", "2026-11-21")).toBe(
      "Search Console hasn't finished 22 Nov yet, so there is nothing to read for it. Its last complete day is 21 Nov.",
    );
  });

  it("writes in house style", () => {
    const zones = ["America/Los_Angeles", "UTC", "Europe/London", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "Etc/GMT+5"];
    const texts = [
      ...zones.map((z) => periodWords({ from: "2026-10-24", to: "2026-11-20", timeZone: z })),
      cappedNote("Google Analytics", "2026-11-21"),
      nothingYetNote("Cloudflare", "2026-11-22", "2026-11-23", "2026-11-21"),
    ];
    for (const t of texts) {
      expect(dashesIn(t), t).toEqual([]);
      expect(aiTellsIn(t), t).toEqual([]);
    }
  });
});
