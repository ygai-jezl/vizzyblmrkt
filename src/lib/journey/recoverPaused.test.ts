import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { JourneyGraph } from "@/lib/types/journey";
import { recoverPausedJourney } from "./recoverPaused";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = Date.parse("2026-09-24T12:00:00.000Z");

const GRAPH = {
  nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "email1", type: "email", position: { x: 0, y: 0 }, data: { subject: "Welcome", body: "Hi" } },
    { id: "wait1", type: "wait", position: { x: 0, y: 0 }, data: { waitHours: 24 } },
    { id: "email2", type: "email", position: { x: 0, y: 0 }, data: { subject: "Next", body: "More" } },
  ],
  edges: [
    { id: "e0", source: "trigger", target: "email1", sourceHandle: null },
    { id: "e1", source: "email1", target: "wait1", sourceHandle: null },
    { id: "e2", source: "wait1", target: "email2", sourceHandle: null },
  ],
} as unknown as JourneyGraph;

function world(status: "active" | "paused") {
  const db = new FakeFirestore();
  db.seed("journeys", "journey_camp1", { tenantId: "ten_A", campaignId: "camp1", status, graph: GRAPH, createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" });
  db.seed("campaigns", "camp1", { id: "camp1", tenantId: "ten_A", waitlistName: "Fernlight", archivedAt: null });
  const person = (id: string, status = "verified_active") =>
    db.seed("signups", id, { id, tenantId: "ten_A", campaignId: "camp1", status, email: `${id}@example.test` });
  const job = (signupId: string, nodeId: string, over: Record<string, unknown> = {}) => {
    const id = `journey:journey_camp1:${nodeId}:${signupId}`;
    db.seed("email_jobs", id, {
      tenantId: "ten_A",
      campaignId: "camp1",
      type: "journey_step",
      status: "done",
      dedupeKey: id,
      scheduledAt: "2026-07-01T09:00:00.000Z",
      attempts: 1,
      claimedAt: "2026-07-01T09:00:05.000Z",
      emailSentAt: null,
      payload: { journeyId: "journey_camp1", nodeId, signupId },
      createdAt: "2026-06-30T09:00:00.000Z",
      processedAt: "2026-07-01T09:00:06.000Z",
      ...over,
    });
    return id;
  };
  // Stranded at email2 when the journey was paused: the one to find.
  person("s1");
  const stranded = job("s1", "email2");
  // Sent normally.
  person("s2");
  job("s2", "email2", { emailSentAt: "2026-07-01T09:00:06.000Z", variantId: "control" });
  // Left under D1's rules (held over 90 days).
  person("s3");
  job("s3", "email2", { endedReason: "hold_expired" });
  // Their sequence carried on after email1, so they aren't stranded there.
  person("s4");
  job("s4", "email1");
  job("s4", "email2", { status: "pending", createdAt: "2026-07-02T09:00:00.000Z", processedAt: null });
  // No longer verified: wouldn't be emailed anyway.
  person("s5", "unverified");
  job("s5", "email2");
  return { db, stranded };
}

describe("recovering people stranded by past pauses (engine move D1)", () => {
  it("finds only people stopped at an email that was never sent, and a dry run changes nothing", async () => {
    const { db, stranded } = world("active");
    const r = await recoverPausedJourney(ctx, "camp1", { db, now: NOW });
    expect(r).toMatchObject({ emailSteps: 1, conditionSteps: 0, recovered: 0, waitingForResume: false });
    expect(r.oldest).toBe("2026-07-01T09:00:06.000Z");
    expect(db.raw("email_jobs", stranded)).toMatchObject({ status: "done" });
  });

  it("puts the missed step back in the queue, once", async () => {
    const { db, stranded } = world("active");
    const r = await recoverPausedJourney(ctx, "camp1", { db, now: NOW, apply: true });
    expect(r.recovered).toBe(1);
    expect(db.raw("email_jobs", stranded)).toMatchObject({
      status: "pending",
      attempts: 0,
      processedAt: null,
      scheduledAt: new Date(NOW).toISOString(),
    });
    const again = await recoverPausedJourney(ctx, "camp1", { db, now: NOW, apply: true });
    expect(again).toMatchObject({ emailSteps: 0, recovered: 0 });
  });

  it("only reports a paused journey: resume it, then run again", async () => {
    const { db, stranded } = world("paused");
    const r = await recoverPausedJourney(ctx, "camp1", { db, now: NOW, apply: true });
    expect(r).toMatchObject({ emailSteps: 1, recovered: 0, waitingForResume: true });
    expect(db.raw("email_jobs", stranded)).toMatchObject({ status: "done" });
  });

  it("returns an empty report for a launch with no journey", async () => {
    const db = new FakeFirestore();
    expect(await recoverPausedJourney(ctx, "camp9", { db })).toMatchObject({ journeyStatus: null, emailSteps: 0, recovered: 0 });
  });
});
