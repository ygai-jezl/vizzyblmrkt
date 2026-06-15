import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import { getLeaderboard } from "./leaderboard";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "camp1",
    tenantId: "ten_A",
    waitlistName: "Beta",
    waitlistUrlLocation: null,
    spotsToMoveUponReferral: 10,
    usesFirstnameLastname: false,
    usesLeaderboard: true,
    usesSignupVerification: false,
    hideCounts: false,
    removeWidgetHeaders: false,
    requiredContactDetail: "EMAIL",
    questions: [],
    sendEmailCongratulationsOnReferral: true,
    leaderboardLength: 5,
    configurationStyleJson: {},
    createdAt: "2026-06-15T16:00:00Z",
    ...over,
  };
}

function seedSignup(
  db: FakeFirestore,
  id: string,
  over: Record<string, unknown>,
) {
  db.seed("signups", id, {
    tenantId: "ten_A",
    campaignId: "camp1",
    firstName: "User",
    lastName: "Example",
    email: "user@example.com",
    phone: null,
    status: "verified_active",
    amountReferred: 0,
    score: 0,
    createdAt: "2026-06-15T16:00:00Z",
    ...over,
  });
}

describe("getLeaderboard", () => {
  it("ranks by referral count desc then earliest signup, masking PII", async () => {
    const db = new FakeFirestore();
    seedSignup(db, "s1", { firstName: "Ana", lastName: "Smith", amountReferred: 1, score: 10, createdAt: "2026-06-15T10:00:00Z" });
    seedSignup(db, "s2", { firstName: "Bo", lastName: "Jones", amountReferred: 3, score: 30, createdAt: "2026-06-15T11:00:00Z" });
    seedSignup(db, "s3", { firstName: "Cy", lastName: "Lee", amountReferred: 1, score: 10, createdAt: "2026-06-15T09:00:00Z" });

    const board = await getLeaderboard(ctx, campaign(), db);
    expect(board.map((e) => e.first_name)).toEqual(["Bo", "Cy", "Ana"]); // 3, then 1/earlier, then 1/later
    expect(board[0]).toMatchObject({ rank: 1, amount_referred: 3, last_name: "J." });
    expect(board.every((e) => !e.email?.includes("@example.com") || e.email.startsWith("u*"))).toBe(true);
  });

  it("still ranks referrers when spotsToMoveUponReferral is 0 (score is 0 for all)", async () => {
    const db = new FakeFirestore();
    // Many early non-referrers + later referrers — with score-based ranking the
    // limit would have returned the early non-referrers and dropped the referrers.
    for (let i = 0; i < 6; i++) {
      seedSignup(db, `early${i}`, { amountReferred: 0, score: 0, createdAt: `2026-06-15T08:0${i}:00Z` });
    }
    seedSignup(db, "ref1", { firstName: "Late", amountReferred: 2, score: 0, createdAt: "2026-06-15T20:00:00Z" });
    seedSignup(db, "ref2", { firstName: "Later", amountReferred: 5, score: 0, createdAt: "2026-06-15T21:00:00Z" });

    const board = await getLeaderboard(ctx, campaign({ spotsToMoveUponReferral: 0 }), db);
    expect(board.map((e) => e.amount_referred)).toEqual([5, 2]); // referrers still appear, ranked by count
  });

  it("excludes signups with zero referrals (empty board, not unreferred users)", async () => {
    const db = new FakeFirestore();
    seedSignup(db, "s1", { amountReferred: 0, score: 0 });
    seedSignup(db, "s2", { amountReferred: 0, score: 0 });
    expect(await getLeaderboard(ctx, campaign(), db)).toEqual([]);
  });

  it("returns [] when the leaderboard is disabled or length is 0", async () => {
    const db = new FakeFirestore();
    seedSignup(db, "s1", { amountReferred: 5, score: 50 });
    expect(await getLeaderboard(ctx, campaign({ usesLeaderboard: false }), db)).toEqual([]);
    expect(await getLeaderboard(ctx, campaign({ leaderboardLength: 0 }), db)).toEqual([]);
  });

  it("respects leaderboardLength", async () => {
    const db = new FakeFirestore();
    for (let i = 0; i < 8; i++) {
      seedSignup(db, `s${i}`, { amountReferred: i + 1, score: (i + 1) * 10 });
    }
    const board = await getLeaderboard(ctx, campaign({ leaderboardLength: 3 }), db);
    expect(board).toHaveLength(3);
    expect(board[0]!.amount_referred).toBe(8); // highest first
  });

  it("does not leak other tenants' signups", async () => {
    const db = new FakeFirestore();
    seedSignup(db, "mine", { amountReferred: 2, score: 20 });
    db.seed("signups", "theirs", {
      tenantId: "ten_B",
      campaignId: "camp1",
      status: "verified_active",
      amountReferred: 99,
      score: 990,
      createdAt: "2026-06-15T08:00:00Z",
    });
    const board = await getLeaderboard(ctx, campaign(), db);
    expect(board).toHaveLength(1);
    expect(board[0]!.amount_referred).toBe(2);
  });
});
