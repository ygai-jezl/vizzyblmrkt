import { describe, it, expect } from "vitest";
import { aggregateSignups } from "./analytics";
import type { Signup } from "@/lib/types/signup";

function s(over: Partial<Signup>): Signup {
  return {
    id: "x",
    tenantId: "ten_A",
    campaignId: "camp1",
    verified: true,
    captchaValid: false,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: "T",
    referralLink: "L",
    score: 0,
    createdAt: "2026-06-15T10:00:00Z",
    ...over,
  } as Signup;
}

describe("aggregateSignups", () => {
  it("counts statuses, referrals, organic and last timestamps", () => {
    const a = aggregateSignups([
      s({ status: "verified_active", amountReferred: 2, createdAt: "2026-06-15T09:00:00Z" }),
      s({ status: "unverified", createdAt: "2026-06-16T09:00:00Z" }),
      s({ status: "offboarded" }),
      s({ status: "verified_active", referredBySignupToken: "REF", createdAt: "2026-06-16T12:00:00Z" }),
    ]);
    expect(a.verifiedSignups).toBe(2);
    expect(a.unverifiedSignups).toBe(1);
    expect(a.offboardedSignups).toBe(1);
    expect(a.totalSignups).toBe(3); // verified + unverified
    expect(a.totalReferrals).toBe(2); // sum amountReferred
    expect(a.referredSignups).toBe(1);
    expect(a.organicSignups).toBe(2); // 3 - 1
    expect(a.lastSignupAt).toBe("2026-06-16T12:00:00Z");
    expect(a.lastReferralAt).toBe("2026-06-16T12:00:00Z");
  });

  it("builds UTM breakdowns sorted by count", () => {
    const a = aggregateSignups([
      s({ utm: { source: "twitter" } }),
      s({ utm: { source: "twitter", medium: "cpc" } }),
      s({ utm: { source: "google" } }),
    ]);
    expect(a.utm.source).toEqual([
      { value: "twitter", count: 2 },
      { value: "google", count: 1 },
    ]);
    expect(a.utm.medium).toEqual([{ value: "cpc", count: 1 }]);
  });

  it("groups referrer hosts and signups by day", () => {
    const a = aggregateSignups([
      s({ referrerUrl: "https://news.ycombinator.com/item?id=1", createdAt: "2026-06-15T08:00:00Z" }),
      s({ referrerUrl: "https://news.ycombinator.com/x", createdAt: "2026-06-15T20:00:00Z" }),
      s({ referrerUrl: "not-a-url", createdAt: "2026-06-16T08:00:00Z" }),
    ]);
    expect(a.referrerSources[0]).toEqual({ value: "news.ycombinator.com", count: 2 });
    expect(a.signupsByDay).toEqual([
      { value: "2026-06-15", count: 2 },
      { value: "2026-06-16", count: 1 },
    ]);
  });

  it("handles an empty campaign", () => {
    const a = aggregateSignups([]);
    expect(a.totalSignups).toBe(0);
    expect(a.lastSignupAt).toBeNull();
    expect(a.utm.source).toEqual([]);
  });
});
