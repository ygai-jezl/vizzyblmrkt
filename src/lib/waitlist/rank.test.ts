import { describe, it, expect } from "vitest";
import { computeRanks } from "./rank";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "ten_x", region: "us", source: "system" };

describe("computeRanks", () => {
  it("ranks by amountReferred desc then createdAt asc (even when score collapses to 0)", async () => {
    const db = new FakeFirestore();
    // spotsToMoveUponReferral == 0 → every score is 0; rank must still use referrals.
    db.seed("signups", "a", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 0, score: 0, createdAt: "2026-01-01T00:00:00Z",
    });
    db.seed("signups", "b", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 5, score: 0, createdAt: "2026-01-02T00:00:00Z",
    });
    db.seed("signups", "c", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 2, score: 0, createdAt: "2026-01-03T00:00:00Z",
    });

    const ranks = await computeRanks(ctx, "c1", db);
    expect(ranks.get("b")).toBe(1); // most referrals → front
    expect(ranks.get("c")).toBe(2);
    expect(ranks.get("a")).toBe(3); // zero referrals → back
  });

  it("excludes other campaigns / non-verified signups", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "x", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 1, score: 0, createdAt: "2026-01-01T00:00:00Z",
    });
    db.seed("signups", "other", {
      tenantId: "ten_x", campaignId: "c2", status: "verified_active",
      amountReferred: 9, score: 0, createdAt: "2026-01-01T00:00:00Z",
    });
    db.seed("signups", "unverified", {
      tenantId: "ten_x", campaignId: "c1", status: "unverified",
      amountReferred: 9, score: 0, createdAt: "2026-01-01T00:00:00Z",
    });
    const ranks = await computeRanks(ctx, "c1", db);
    expect(ranks.size).toBe(1);
    expect(ranks.get("x")).toBe(1);
  });

  it("folds engagementBonus into the queue rank (completing the chat moves a user up)", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 3, score: 0, createdAt: "2026-01-01T00:00:00Z",
    });
    // 1 referral + a 5-spot conversation bonus → effective weight 6, ahead of 'a'.
    db.seed("signups", "b", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 1, engagementBonus: 5, score: 0, createdAt: "2026-01-02T00:00:00Z",
    });
    const ranks = await computeRanks(ctx, "c1", db);
    expect(ranks.get("b")).toBe(1);
    expect(ranks.get("a")).toBe(2);
  });

  it("folds the admin manualBoost into the queue rank (Move up overtakes referrers)", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 4, score: 0, createdAt: "2026-01-01T00:00:00Z",
    });
    // 0 referrals but a 5-spot admin boost → effective weight 5, ahead of 'a' (4).
    db.seed("signups", "b", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 0, manualBoost: 5, score: 0, createdAt: "2026-01-02T00:00:00Z",
    });
    const ranks = await computeRanks(ctx, "c1", db);
    expect(ranks.get("b")).toBe(1);
    expect(ranks.get("a")).toBe(2);
  });

  it("is unchanged when no signup has an engagementBonus (feature off)", async () => {
    const db = new FakeFirestore();
    db.seed("signups", "a", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 5, score: 0, createdAt: "2026-01-02T00:00:00Z",
    });
    db.seed("signups", "b", {
      tenantId: "ten_x", campaignId: "c1", status: "verified_active",
      amountReferred: 5, score: 0, createdAt: "2026-01-01T00:00:00Z",
    });
    const ranks = await computeRanks(ctx, "c1", db);
    // Equal referrals → earlier createdAt wins, exactly as before.
    expect(ranks.get("b")).toBe(1);
    expect(ranks.get("a")).toBe(2);
  });
});
