import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { setJourneyState } from "./service";

/**
 * Engine move D6: retiring the original editor never strands anyone — a journey
 * that has run can still be paused and resumed; only one that never ran can't
 * start on it.
 */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const GRAPH = {
  nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "email1", type: "email", position: { x: 0, y: 0 }, data: { subject: "Hi", body: "Hi" } },
  ],
  edges: [{ id: "e0", source: "trigger", target: "email1", sourceHandle: null }],
};

function world(status: "draft" | "paused") {
  const db = new FakeFirestore();
  db.seed("campaigns", "camp1", { tenantId: "ten_A", waitlistName: "Fernlight", archivedAt: null });
  db.seed("journeys", "journey_camp1", { tenantId: "ten_A", campaignId: "camp1", status, graph: GRAPH, createdAt: "", updatedAt: "" });
  return db;
}

beforeEach(() => vi.stubEnv("WAITLIST_LEGACY_EDITOR", "read_only"));
afterEach(() => vi.unstubAllEnvs());

describe("retiring the original editor", () => {
  it("won't start a journey that never ran", async () => {
    expect(await setJourneyState(ctx, "camp1", "activate", world("draft"))).toEqual({ ok: false, error: "original_editor_retired" });
  });

  it("still pauses and resumes one that has run", async () => {
    const db = world("paused");
    expect(await setJourneyState(ctx, "camp1", "activate", db)).toMatchObject({ ok: true, status: "active" });
    expect(await setJourneyState(ctx, "camp1", "pause", db)).toEqual({ ok: true, status: "paused" });
  });
});
