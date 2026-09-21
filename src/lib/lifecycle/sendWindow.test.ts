import { describe, it, expect } from "vitest";
import { SendPolicySchema } from "@/lib/types/lifecycle";
import {
  WINDOW_GRACE_MS,
  isInSendWindow,
  localDateKey,
  nextWindowAt,
  personalOffsetMinutes,
  resolveTimezone,
  scheduleAfterWait,
  wallTimeToUtc,
  weekdayOfKey,
} from "./sendWindow";

const policy = SendPolicySchema.parse({}); // Mon–Fri, 09:00 + up to 90 min
const H = 3600_000;
const ZONES = ["Europe/London", "America/New_York", "Asia/Kolkata", "Australia/Sydney", "Africa/Cairo", "Asia/Jerusalem"];

function localHM(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const [h, m] = f.format(new Date(ms)).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

describe("wallTimeToUtc (DST-safe)", () => {
  it("lands on 09:00 local either side of a DST change", () => {
    expect(new Date(wallTimeToUtc("2026-10-23", 9, 0, "Europe/London")).toISOString()).toBe("2026-10-23T08:00:00.000Z"); // BST
    expect(new Date(wallTimeToUtc("2026-10-26", 9, 0, "Europe/London")).toISOString()).toBe("2026-10-26T09:00:00.000Z"); // GMT
    expect(new Date(wallTimeToUtc("2026-10-30", 9, 0, "America/New_York")).toISOString()).toBe("2026-10-30T13:00:00.000Z"); // EDT
    expect(new Date(wallTimeToUtc("2026-11-02", 9, 0, "America/New_York")).toISOString()).toBe("2026-11-02T14:00:00.000Z"); // EST
    expect(new Date(wallTimeToUtc("2026-10-05", 9, 0, "Australia/Sydney")).toISOString()).toBe("2026-10-04T22:00:00.000Z"); // AEDT
    expect(new Date(wallTimeToUtc("2026-09-21", 9, 0, "Asia/Kolkata")).toISOString()).toBe("2026-09-21T03:30:00.000Z");
  });

  it("carries minutes past 59 into the hour", () => {
    expect(new Date(wallTimeToUtc("2026-09-21", 9, 75, "UTC")).toISOString()).toBe("2026-09-21T10:15:00.000Z");
  });
});

describe("send windows", () => {
  it("gives every user a stable minute inside the window", () => {
    for (const seed of ["a", "b", "enr_123", "enr_456"]) {
      const off = personalOffsetMinutes(seed, policy);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(policy.windowMinutes);
      expect(personalOffsetMinutes(seed, policy)).toBe(off);
    }
  });

  it("never schedules outside the window, on a weekend, or in the past (property sweep)", () => {
    const start = Date.parse("2026-10-19T00:00:00Z"); // spans the London + New York DST changes
    for (const tz of ZONES) {
      for (const off of [0, 45, 89]) {
        for (let t = start; t < start + 21 * 24 * H; t += 7 * H) {
          const slot = nextWindowAt(t, tz, policy, off);
          expect(slot).toBeGreaterThanOrEqual(t);
          expect(slot - t).toBeLessThanOrEqual(4 * 24 * H);
          expect(isInSendWindow(slot, tz, policy, off)).toBe(true);
          const key = localDateKey(slot, tz);
          expect([1, 2, 3, 4, 5]).toContain(weekdayOfKey(key));
          expect(localHM(slot, tz)).toBe(9 * 60 + off);
        }
      }
    }
  });

  it("is only open for the grace period after the slot", () => {
    const tz = "Europe/London";
    const slot = nextWindowAt(Date.parse("2026-09-21T00:00:00Z"), tz, policy, 30); // Monday
    expect(isInSendWindow(slot - 1, tz, policy, 30)).toBe(false);
    expect(isInSendWindow(slot, tz, policy, 30)).toBe(true);
    expect(isInSendWindow(slot + WINDOW_GRACE_MS - 1, tz, policy, 30)).toBe(true);
    expect(isInSendWindow(slot + WINDOW_GRACE_MS, tz, policy, 30)).toBe(false);
    expect(isInSendWindow(Date.parse("2026-09-26T08:30:00Z"), tz, policy, 30)).toBe(false); // Saturday
  });

  it("falls back to a valid zone", () => {
    expect(resolveTimezone("Mars/Olympus", null, "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(resolveTimezone(undefined, "")).toBe("UTC");
  });
});

describe("scheduleAfterWait", () => {
  const tz = "Europe/London";
  const anchor = Date.parse("2026-09-21T09:00:00Z"); // Monday 10:00 BST

  it("sends the welcome immediately inside its exemption", () => {
    const s = scheduleAfterWait({
      wait: { minHours: 0.25, windowExemptHours: 2.25 },
      anchorMs: anchor, lastSentMs: null, nowMs: anchor, tz, policy, offsetMin: 10,
    });
    expect(s.runAtMs).toBe(anchor + 0.25 * H);
    expect(s.windowExemptUntilMs).toBe(anchor + 2.25 * H);
  });

  it("puts the next email on a later local day, in the window", () => {
    const lastSent = anchor + 0.25 * H;
    const s = scheduleAfterWait({
      wait: { minHours: 12, differentLocalDay: true },
      anchorMs: anchor, lastSentMs: lastSent, nowMs: lastSent, tz, policy, offsetMin: 10,
    });
    expect(new Date(s.runAtMs).toISOString()).toBe("2026-09-22T08:10:00.000Z"); // Tue 09:10 BST
  });

  it("respects the time since enrolment and skips the weekend", () => {
    const lastSent = Date.parse("2026-09-24T08:10:00Z"); // Thu
    const s = scheduleAfterWait({
      wait: { minHours: 40, sinceEnrolHours: 116 },
      anchorMs: anchor, lastSentMs: lastSent, nowMs: lastSent, tz, policy, offsetMin: 10,
    });
    // ≥ Fri 16:10Z and ≥ anchor+116h (Sat 05:00Z) → next weekday window: Mon 28th 09:10 BST
    expect(new Date(s.runAtMs).toISOString()).toBe("2026-09-28T08:10:00.000Z");
  });
});
