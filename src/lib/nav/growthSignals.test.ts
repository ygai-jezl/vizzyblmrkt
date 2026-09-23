import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { loadGrowthSignals, loadWeekCounts } from "./growthSignals";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const other: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };

function seed(db: FakeFirestore) {
  db.seed("campaigns", "c_old", { tenantId: "ten_A", waitlistName: "Old", createdAt: "2026-01-01T00:00:00Z" });
  db.seed("campaigns", "c_new", { tenantId: "ten_A", waitlistName: "New", createdAt: "2026-09-01T00:00:00Z" });
  db.seed("campaigns", "c_arch", {
    tenantId: "ten_A",
    waitlistName: "Gone",
    createdAt: "2026-09-10T00:00:00Z",
    archivedAt: "2026-09-11T00:00:00Z",
  });
  db.seed("journeys", "journey_c_new", { tenantId: "ten_A", status: "active" });
  db.seed("signups", "s1", { tenantId: "ten_A", status: "verified_active", createdAt: "2026-09-20T00:00:00Z" });
  db.seed("signups", "s2", { tenantId: "ten_A", status: "unverified", createdAt: "2026-09-01T00:00:00Z" });
  db.seed("signups", "s3", { tenantId: "ten_A", status: "offboarded", createdAt: "2026-09-21T00:00:00Z" });
  db.seed("signups", "sx", { tenantId: "ten_B", status: "verified_active", createdAt: "2026-09-21T00:00:00Z" });
  db.seed("workspaces", "w1", { tenantId: "ten_A", name: "Weekly", createdAt: "2026-09-02T00:00:00Z" });
  db.seed("campaign_scheduled_posts", "p1", { tenantId: "ten_A", jobKind: "publish", status: "pending" });
  db.seed("campaign_scheduled_posts", "p2", { tenantId: "ten_A", jobKind: "performance_fetch", status: "done" });
  db.seed("product_connections", "pc_sandbox", {
    tenantId: "ten_A",
    kind: "sandbox",
    status: "active",
    createdAt: "2026-09-03T00:00:00Z",
    catalog: { onboardingSteps: [{ id: "a" }] },
    health: { lastEventAt: "2026-09-22T00:00:00Z" },
  });
  db.seed("product_connections", "pc_real", {
    tenantId: "ten_A",
    kind: "custom",
    status: "active",
    createdAt: "2026-09-04T00:00:00Z",
    catalog: { onboardingSteps: [{ id: "a" }, { id: "b" }] },
    health: {},
  });
  db.seed("lifecycle_journeys", "lcj_1", {
    tenantId: "ten_A",
    status: "active",
    deliveryMode: "test",
    publishedVersion: 2,
    updatedAt: "2026-09-22T00:00:00Z",
  });
}

describe("loadGrowthSignals", () => {
  it("reads each stage's facts, tenant-scoped", async () => {
    const db = new FakeFirestore();
    seed(db);
    const s = await loadGrowthSignals(ctx, { lifecycle: true }, db);
    expect(s.activeLaunches).toBe(2);
    expect(s.firstLaunchId).toBe("c_new"); // newest active, not the archived one
    expect(s.welcomeEmailLive).toBe(true);
    expect(s.signups).toBe(2); // verified + unverified; offboarded and ten_B excluded
    expect(s.workspaces).toBe(1);
    expect(s.postsScheduled).toBe(1); // follow-up jobs don't count
    expect(s.products).toBe(1); // the sandbox doesn't count
    expect(s.catalogReady).toBe(true);
    expect(s.eventsReceived).toBe(false); // only the sandbox has events
    expect(s.catalogSteps).toBe(2);
    expect(s.journeys).toBe(1);
    expect(s.journeyPublished).toBe(true);
    expect(s.journeyLive).toBe(false); // published in test mode only
  });

  it("skips product reads where lifecycle is off", async () => {
    const db = new FakeFirestore();
    seed(db);
    const s = await loadGrowthSignals(ctx, { lifecycle: false }, db);
    expect(s.products).toBe(0);
    expect(s.journeys).toBe(0);
    expect(s.lifecycle).toBe(false);
  });

  it("an empty brand has nothing", async () => {
    const s = await loadGrowthSignals(other, { lifecycle: true }, new FakeFirestore());
    expect(s.activeLaunches).toBe(0);
    expect(s.signups).toBe(0);
    expect(s.firstLaunchId).toBeNull();
  });
});

describe("loadWeekCounts", () => {
  it("counts the last seven days", async () => {
    const db = new FakeFirestore();
    seed(db);
    const w = await loadWeekCounts(ctx, { lifecycle: true, now: new Date("2026-09-23T12:00:00Z") }, db);
    expect(w.signups).toBe(2); // s1 and the offboarded s3 joined this week
    expect(w.liveJourneys).toBe(0);
  });
});
