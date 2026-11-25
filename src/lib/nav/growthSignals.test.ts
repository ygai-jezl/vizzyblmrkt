import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
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
    expect(s.recordsEver).toBe(0);
  });

  it("counts every record the brand ever made, archived ones and sandboxes too", async () => {
    const db = new FakeFirestore();
    seed(db);
    // 3 launches (one archived), 1 programme, 2 connections (one a sandbox), 1 journey.
    expect((await loadGrowthSignals(ctx, { lifecycle: true }, db)).recordsEver).toBe(7);
    expect((await loadGrowthSignals(other, { lifecycle: true }, db)).recordsEver).toBe(0);

    const archivedOnly = new FakeFirestore();
    archivedOnly.seed("campaigns", "c_arch", { tenantId: "ten_A", waitlistName: "Gone", createdAt: "2026-09-10T00:00:00Z", archivedAt: "2026-09-11T00:00:00Z" });
    archivedOnly.seed("workspaces", "w_arch", { tenantId: "ten_A", name: "Old", archivedAt: "2026-09-11T00:00:00Z" });
    const s = await loadGrowthSignals(ctx, { lifecycle: true }, archivedOnly);
    expect(s.activeLaunches).toBe(0);
    expect(s.workspaces).toBe(0);
    expect(s.recordsEver).toBe(2);
  });

  it("knows whether any programme, connection or product journey exists, archived, sandbox and revoked too", async () => {
    const db = new FakeFirestore();
    seed(db);
    const s = await loadGrowthSignals(ctx, { lifecycle: true }, db);
    expect([s.anyProgramme, s.anyConnection, s.anyProductJourney]).toEqual([true, true, true]);
    const empty = await loadGrowthSignals(other, { lifecycle: true }, db);
    expect([empty.anyProgramme, empty.anyConnection, empty.anyProductJourney]).toEqual([false, false, false]);

    const kept = new FakeFirestore();
    kept.seed("workspaces", "w_arch", { tenantId: "ten_A", name: "Old", archivedAt: "2026-09-11T00:00:00Z" });
    kept.seed("product_connections", "pc_sandbox", { tenantId: "ten_A", kind: "sandbox", status: "revoked" });
    kept.seed("lifecycle_journeys", "lcj_welcome", { tenantId: "ten_A", status: "active", connectionId: "", audience: { kind: "waitlist", campaignId: "c1" } });
    const k = await loadGrowthSignals(ctx, { lifecycle: true }, kept);
    expect(k.workspaces).toBe(0);
    expect(k.products).toBe(0);
    expect([k.anyProgramme, k.anyConnection, k.anyProductJourney]).toEqual([true, true, false]);
    kept.seed("lifecycle_journeys", "lcj_arch", { tenantId: "ten_A", status: "archived", connectionId: "pc_sandbox" });
    expect((await loadGrowthSignals(ctx, { lifecycle: true }, kept)).anyProductJourney).toBe(true);
  });

  it("doesn't know the count when a list it counts couldn't be read", async () => {
    for (const collection of ["campaigns", "workspaces", "product_connections", "lifecycle_journeys"]) {
      const s = await loadGrowthSignals(other, { lifecycle: true }, failingFirestore(new FakeFirestore(), { collections: [collection] }));
      expect(s.recordsEver, collection).toBeNull();
    }
    // A count failing (signups, posts) leaves the lists, so the count is still known.
    const counts = await loadGrowthSignals(other, { lifecycle: true }, failingFirestore(new FakeFirestore(), { counts: true }));
    expect(counts.recordsEver).toBe(0);
    expect(counts.signups).toBeNull();
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
