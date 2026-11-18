import { describe, expect, it } from "vitest";
import { reportDue, statsOf } from "./reports";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const day = 24 * 3600_000;
const report = {
  emails_sent: 300,
  opens: { open_rate: 0.4, opens_total: 210, unique_opens: 120, last_open: "2026-11-17T09:00:00Z" },
  clicks: { click_rate: 0.05, clicks_total: 22, unique_clicks: 15, last_click: "" },
  unsubscribed: 2,
  bounces: { hard_bounces: 3, soft_bounces: 1 },
  abuse_reports: 1,
  forwards: { forwards_count: 4 },
};

describe("MailChimp report detail", () => {
  it("keeps the 4 numbers shown today, and the whole report only with the switch on", () => {
    expect(statsOf(report, false, "t")).toEqual({ emailsSent: 300, openRate: 0.4, clickRate: 0.05, unsubscribed: 2 });
    expect(statsOf(report, true, "t")).toEqual({
      emailsSent: 300, openRate: 0.4, clickRate: 0.05, unsubscribed: 2,
      uniqueOpens: 120, totalOpens: 210, uniqueClicks: 15, totalClicks: 22,
      hardBounces: 3, softBounces: 1, complaints: 1, forwards: 4,
      lastOpenAt: "2026-11-17T09:00:00Z", lastClickAt: null, syncedAt: "t",
    });
  });

  it("syncs daily for 14 days, then weekly until 90 days with detail; 14 days without", () => {
    const sent = (daysAgo: number, syncedDaysAgo?: number) => ({
      sentAt: new Date(NOW - daysAgo * day).toISOString(),
      stats: syncedDaysAgo === undefined ? null : { syncedAt: new Date(NOW - syncedDaysAgo * day).toISOString() },
    });
    expect(reportDue(sent(3), NOW, false)).toBe(true);
    expect(reportDue(sent(20), NOW, false)).toBe(false);
    expect(reportDue(sent(3, 0), NOW, true)).toBe(true);
    expect(reportDue(sent(30, 2), NOW, true)).toBe(false);
    expect(reportDue(sent(30, 8), NOW, true)).toBe(true);
    expect(reportDue(sent(120, 30), NOW, true)).toBe(false);
  });
});
