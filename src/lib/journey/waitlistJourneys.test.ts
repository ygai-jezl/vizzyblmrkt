import { describe, it, expect } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { loadWaitlistJourneys, waitlistJourneyRows } from "./waitlistJourneys";

const graph = (emails: number) => ({
  nodes: [
    { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    ...Array.from({ length: emails }, (_, i) => ({ id: `e${i}`, type: "email", position: { x: 0, y: 0 }, data: {} })),
  ],
  edges: [],
});

describe("waitlistJourneyRows", () => {
  it("lists every launch, live first, archived last", () => {
    const rows = waitlistJourneyRows(
      [
        { id: "draft", waitlistName: "Draft launch" },
        { id: "none", waitlistName: "No journey yet" },
        { id: "live", waitlistName: "Live launch" },
        { id: "old", waitlistName: "Old launch", archivedAt: "2026-09-01T00:00:00Z" },
      ],
      [
        { campaignId: "draft", status: "draft", graph: graph(2), updatedAt: "2026-09-20T00:00:00Z" } as never,
        { campaignId: "live", status: "active", graph: graph(5), updatedAt: "2026-09-10T00:00:00Z" } as never,
        { campaignId: "old", status: "paused", graph: graph(1), updatedAt: "2026-09-02T00:00:00Z" } as never,
      ],
    );
    expect(rows.map((r) => `${r.campaignId}:${r.status}:${r.emails}`)).toEqual([
      "live:active:5",
      "draft:draft:2",
      "none:not_started:0",
      "old:paused:1",
    ]);
    expect(rows[0]!.href).toBe("/admin/launches/live/journey");
  });
});

describe("loadWaitlistJourneys", () => {
  it("reads launches and journeys for the tenant", async () => {
    const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
    const db = new FakeFirestore();
    db.seed("campaigns", "c1", { tenantId: "ten_A", waitlistName: "Beta", createdAt: "2026-09-01T00:00:00Z" });
    db.seed("campaigns", "cx", { tenantId: "ten_B", waitlistName: "Other", createdAt: "2026-09-01T00:00:00Z" });
    db.seed("journeys", "journey_c1", { tenantId: "ten_A", campaignId: "c1", status: "active", graph: graph(3), updatedAt: "2026-09-02T00:00:00Z" });
    const rows = await loadWaitlistJourneys(ctx, db);
    expect(rows).toEqual([
      expect.objectContaining({ campaignId: "c1", launchName: "Beta", status: "active", emails: 3 }),
    ]);
  });
});
