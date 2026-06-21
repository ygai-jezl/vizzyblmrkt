import { describe, it, expect } from "vitest";
import {
  computeScore,
  comparePriority,
  signupUnixSeconds,
  effectiveReferralWeight,
} from "./scoring";

describe("effectiveReferralWeight", () => {
  it("equals amountReferred when there is no engagement bonus", () => {
    expect(effectiveReferralWeight({ amountReferred: 4 })).toBe(4);
    expect(effectiveReferralWeight({ amountReferred: 0, engagementBonus: 0 })).toBe(0);
  });

  it("adds the conversation engagement bonus to referrals", () => {
    expect(effectiveReferralWeight({ amountReferred: 1, engagementBonus: 5 })).toBe(6);
  });

  it("adds the admin manualBoost (Move up) on top of referrals + bonus", () => {
    expect(effectiveReferralWeight({ amountReferred: 2, manualBoost: 10 })).toBe(12);
    expect(
      effectiveReferralWeight({ amountReferred: 1, engagementBonus: 3, manualBoost: 4 }),
    ).toBe(8);
    // No boost/bonus → unchanged (feature-off parity).
    expect(effectiveReferralWeight({ amountReferred: 7 })).toBe(7);
  });
});

describe("computeScore", () => {
  it("is zero with no referrals", () => {
    expect(computeScore(0, 3)).toBe(0);
  });

  it("is referrals × spotsToMoveUponReferral", () => {
    expect(computeScore(4, 3)).toBe(12);
    expect(computeScore(10, 1000)).toBe(10_000);
  });

  it("rejects non-integer / negative inputs (guards the ms-vs-seconds bug class)", () => {
    expect(() => computeScore(1.5, 3)).toThrow(RangeError);
    expect(() => computeScore(-1, 3)).toThrow(RangeError);
    expect(() => computeScore(2, 3.3)).toThrow(RangeError);
  });
});

describe("signupUnixSeconds", () => {
  it("returns integer seconds, not milliseconds", () => {
    expect(signupUnixSeconds("2026-06-15T16:00:00Z")).toBe(1781539200);
  });
  it("throws on an invalid timestamp", () => {
    expect(() => signupUnixSeconds("not-a-date")).toThrow(RangeError);
  });
});

describe("comparePriority", () => {
  it("ranks higher score toward the front", () => {
    expect(
      comparePriority(
        { score: 10, createdAt: "2026-01-01T00:00:00Z" },
        { score: 5, createdAt: "2026-01-01T00:00:00Z" },
      ),
    ).toBeLessThan(0);
  });

  it("breaks ties by earlier signup", () => {
    expect(
      comparePriority(
        { score: 5, createdAt: "2026-01-01T00:00:00Z" },
        { score: 5, createdAt: "2026-01-02T00:00:00Z" },
      ),
    ).toBeLessThan(0);
  });

  it("sorts a queue front-to-back", () => {
    const queue = [
      { score: 5, createdAt: "2026-01-02T00:00:00Z" },
      { score: 5, createdAt: "2026-01-01T00:00:00Z" },
      { score: 9, createdAt: "2026-02-01T00:00:00Z" },
    ];
    queue.sort(comparePriority);
    expect(queue[0]!.score).toBe(9);
    expect(queue[1]!.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(queue[2]!.createdAt).toBe("2026-01-02T00:00:00Z");
  });
});
