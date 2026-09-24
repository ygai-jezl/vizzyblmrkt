import { describe, expect, it, vi } from "vitest";

// Publishing drains the queue inline; these tests stop before any send.
vi.mock("@/lib/email/delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/delivery")>();
  return { ...actual, processEmailJobs: vi.fn(async () => ({ processed: 0, done: 0, failed: 0 })) };
});

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Journey, JourneyGraph } from "@/lib/types/journey";
import { countHeldJourneySteps, releaseHeldJourneySteps, RELEASE_PER_TICK } from "./hold";
import { setJourneyState } from "./service";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

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

function world(status: "active" | "paused" = "paused", archived = false) {
  const db = new FakeFirestore();
  db.seed("journeys", "journey_camp1", {
    tenantId: "ten_A",
    campaignId: "camp1",
    status,
    graph: GRAPH,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  });
  db.seed("campaigns", "camp1", { id: "camp1", tenantId: "ten_A", waitlistName: "Fernlight", archivedAt: archived ? daysAgo(3) : null });
  return db;
}

function step(
  db: FakeFirestore,
  signupId: string,
  over: { nodeId?: string; status?: string; heldAt?: string; scheduledAt?: string; journeyId?: string } = {},
) {
  const nodeId = over.nodeId ?? "email2";
  const journeyId = over.journeyId ?? "journey_camp1";
  const id = `journey:${journeyId}:${nodeId}:${signupId}`;
  db.seed("email_jobs", id, {
    tenantId: "ten_A",
    campaignId: "camp1",
    type: "journey_step",
    status: over.status ?? "held",
    heldReason: "journey_paused",
    heldAt: over.heldAt ?? daysAgo(2),
    dedupeKey: id,
    scheduledAt: over.scheduledAt ?? daysAgo(2),
    attempts: 0,
    claimedAt: null,
    payload: { journeyId, nodeId, signupId },
    createdAt: daysAgo(10),
  });
  return id;
}

const journeyOf = (db: FakeFirestore) => ({ id: "journey_camp1", ...db.raw("journeys", "journey_camp1") }) as unknown as Journey;

describe("releasing held steps (engine move D1)", () => {
  it("releases waiting people, lets long-held and removed-step people leave, and touches nothing else", async () => {
    const db = world("active");
    const waiting = step(db, "s1");
    const longHeld = step(db, "s2", { heldAt: daysAgo(91) });
    const removed = step(db, "s3", { nodeId: "email_removed" });
    const otherJourney = step(db, "s4", { journeyId: "journey_other" });
    const queued = step(db, "s5", { status: "pending" });

    const summary = await releaseHeldJourneySteps(ctx, journeyOf(db), { now: NOW, db });
    expect(summary).toEqual({ released: 1, expired: 1, stepRemoved: 1 });
    expect(db.raw("email_jobs", waiting)).toMatchObject({ status: "pending", heldReason: null, heldAt: null, scheduledAt: new Date(NOW).toISOString() });
    expect(db.raw("email_jobs", longHeld)).toMatchObject({ status: "done", endedReason: "hold_expired" });
    expect(db.raw("email_jobs", removed)).toMatchObject({ status: "done", endedReason: "step_removed" });
    expect(db.raw("email_jobs", otherJourney)).toMatchObject({ status: "held" });
    expect(db.raw("email_jobs", queued)).toMatchObject({ status: "pending", scheduledAt: daysAgo(2) });
    // Idempotent: nothing is left to release.
    expect(await releaseHeldJourneySteps(ctx, journeyOf(db), { now: NOW, db })).toEqual({ released: 0, expired: 0, stepRemoved: 0 });
  });

  it("paces a big resume at one worker tick's worth at a time, oldest first", async () => {
    const db = world("active");
    for (let i = 0; i <= RELEASE_PER_TICK; i += 1) {
      step(db, `s${String(i).padStart(3, "0")}`, { scheduledAt: new Date(NOW - 3_600_000 + i * 1000).toISOString() });
    }
    expect(await countHeldJourneySteps(ctx, "camp1", db)).toBe(RELEASE_PER_TICK + 1);
    const summary = await releaseHeldJourneySteps(ctx, journeyOf(db), { now: NOW, db });
    expect(summary.released).toBe(RELEASE_PER_TICK + 1);
    const times = db.dump("email_jobs").map((j) => j.scheduledAt as string);
    expect(times.filter((t) => t === new Date(NOW).toISOString())).toHaveLength(RELEASE_PER_TICK);
    expect(times.filter((t) => t === new Date(NOW + 2 * 60_000).toISOString())).toHaveLength(1);
    // The newest-due step is the one pushed to the next tick.
    expect(db.raw("email_jobs", `journey:journey_camp1:email2:s${String(RELEASE_PER_TICK).padStart(3, "0")}`)!.scheduledAt).toBe(
      new Date(NOW + 2 * 60_000).toISOString(),
    );
  });
});

describe("publishing a journey (engine move D1)", () => {
  it("refuses an archived launch: restore it first", async () => {
    const db = world("paused", true);
    expect(await setJourneyState(ctx, "camp1", "activate", db)).toEqual({ ok: false, error: "launch_archived" });
    expect(db.raw("journeys", "journey_camp1")).toMatchObject({ status: "paused" });
  });

  it("turning a paused journey back on releases the people waiting and enrols newcomers", async () => {
    const db = world("paused");
    db.seed("signups", "s1", { id: "s1", tenantId: "ten_A", campaignId: "camp1", status: "verified_active", email: "ada@example.test" });
    db.seed("signups", "s2", { id: "s2", tenantId: "ten_A", campaignId: "camp1", status: "verified_active", email: "bo@example.test" });
    // s1 was part-way through (held at email1, so publishing doesn't enrol them again); s2 is new.
    const held = step(db, "s1", { nodeId: "email1" });

    const r = await setJourneyState(ctx, "camp1", "activate", db);
    expect(r).toMatchObject({ ok: true, status: "active", enqueued: 1, held: { released: 1, expired: 0, stepRemoved: 0 } });
    expect(db.raw("email_jobs", held)).toMatchObject({ status: "pending" });
    expect(db.raw("email_jobs", "journey:journey_camp1:email1:s2")).toMatchObject({ status: "pending" });
  });
});
