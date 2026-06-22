import { describe, it, expect } from "vitest";
import { computeHybridAnalytics, computeCampaignAnalytics } from "./analytics";
import { computeHybridEmailAnalytics, computeEmailAnalytics } from "./email";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

const ctx: TenantContext = { tenantId: "t1", region: "us", source: "system" };

function seedSignup(db: FakeFirestore, id: string, over: Record<string, unknown>): void {
  db.seed("signups", id, {
    tenantId: "t1",
    campaignId: "c1",
    verified: true,
    captchaValid: false,
    isSpam: false,
    status: "verified_active",
    amountReferred: 0,
    referralToken: `T${id}`,
    referralLink: "L",
    score: 0,
    createdAt: "2026-06-15T10:00:00Z",
    ...over,
  });
}

describe("computeHybridAnalytics — BigQuery off → Firestore fallback", () => {
  it("returns the Firestore payload plus provenance, with no view metrics", async () => {
    const db = new FakeFirestore();
    seedSignup(db, "a", {
      utm: { source: "twitter" },
      referrerUrl: "https://news.ycombinator.com/item?id=1",
    });
    seedSignup(db, "b", { status: "unverified" });

    const fs = await computeCampaignAnalytics(ctx, "c1", db);
    const hy = await computeHybridAnalytics(ctx, "c1", db);

    // Identical KPI + breakdown payload, with the Firestore provenance tags and
    // no impression metrics (those only exist when BigQuery view-tracking is on).
    expect(hy).toMatchObject(fs);
    expect(hy.source).toEqual({
      kpis: "firestore",
      breakdowns: "firestore",
      views: "absent",
    });
    expect(hy.viewsByDay).toBeUndefined();
    expect(hy.viewReferrerSources).toBeUndefined();
  });

  it("still falls back when the flag is on but no region dataset is configured", async () => {
    const db = new FakeFirestore();
    seedSignup(db, "a", {});
    const prev = process.env.ANALYTICS_BQ_ENABLED;
    process.env.ANALYTICS_BQ_ENABLED = "true";
    try {
      // No BQ_DATASET_* env in tests → resolveTarget() is null → null breakdowns
      // → Firestore fallback. (Even if a dataset WERE set, the query would fail
      // with no creds and still degrade.) The point: never throw, always render.
      const hy = await computeHybridAnalytics(ctx, "c1", db);
      expect(hy.source.breakdowns).toBe("firestore");
    } finally {
      if (prev === undefined) delete process.env.ANALYTICS_BQ_ENABLED;
      else process.env.ANALYTICS_BQ_ENABLED = prev;
    }
  });
});

describe("computeHybridEmailAnalytics — BigQuery off → Firestore fallback", () => {
  it("equals computeEmailAnalytics when the pipeline is off", async () => {
    const db = new FakeFirestore();
    db.seed("broadcasts", "b1", {
      tenantId: "t1",
      campaignId: "c1",
      name: "Teaser",
      subject: "s",
      body: "b",
      status: "sent",
      stats: { emailsSent: 10, openRate: 0.5, clickRate: 0.1 },
      createdAt: "2026-06-10T00:00:00.000Z",
    });

    const fs = await computeEmailAnalytics(ctx, "c1", db);
    const hy = await computeHybridEmailAnalytics(ctx, "c1", db);
    expect(hy).toEqual(fs);
  });
});
