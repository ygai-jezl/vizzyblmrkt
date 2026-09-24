import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { JourneyGraph } from "@/lib/types/journey";
import { activateJourney, enrollSignupInActiveJourney, processEmailJobs } from "./delivery";
import { enrolSignupInWaitlistJourney } from "@/lib/journey/router";
import { suppressionDocId } from "./suppression";

/**
 * Engine move D1: a paused journey or an archived launch HOLDS each person's
 * next step instead of ending their sequence. Nothing here reaches a send: every
 * case stops at the hold (or earlier), so no provider is involved.
 */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

// trigger → email1 → wait(24h) → email2
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

function world(opts: { journey?: "active" | "paused" | "draft"; archived?: boolean; signup?: boolean } = {}) {
  const db = new FakeFirestore();
  db.seed("journeys", "journey_camp1", {
    tenantId: "ten_A",
    campaignId: "camp1",
    status: opts.journey ?? "paused",
    graph: GRAPH,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  });
  db.seed("campaigns", "camp1", {
    id: "camp1",
    tenantId: "ten_A",
    waitlistName: "Fernlight",
    archivedAt: opts.archived ? "2026-09-20T00:00:00Z" : null,
  });
  if (opts.signup !== false) {
    db.seed("signups", "s1", { id: "s1", tenantId: "ten_A", campaignId: "camp1", status: "verified_active", email: "ada@example.test" });
  }
  return db;
}

function dueStep(db: FakeFirestore, nodeId = "email2", signupId = "s1") {
  const id = `journey:journey_camp1:${nodeId}:${signupId}`;
  db.seed("email_jobs", id, {
    tenantId: "ten_A",
    campaignId: "camp1",
    type: "journey_step",
    status: "pending",
    dedupeKey: id,
    scheduledAt: "2026-09-20T09:00:00.000Z",
    attempts: 0,
    claimedAt: null,
    emailSentAt: null,
    payload: { journeyId: "journey_camp1", nodeId, signupId },
    lastError: null,
    createdAt: "2026-09-19T09:00:00.000Z",
    processedAt: null,
  });
  return id;
}

beforeEach(() => vi.stubEnv("WAITLIST_JOURNEY_HOLD_ON_PAUSE", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("holding waitlist journey steps (engine move D1)", () => {
  it("holds the next step of a paused journey instead of ending the sequence", async () => {
    const db = world({ journey: "paused" });
    const id = dueStep(db);
    const r = await processEmailJobs(ctx, 25, db);
    expect(r.failed).toBe(0);
    expect(db.raw("email_jobs", id)).toMatchObject({ status: "held", heldReason: "journey_paused", attempts: 0, claimedAt: null });
    expect(db.raw("email_jobs", id)!.heldAt).toEqual(expect.any(String));
    expect(db.dump("email_events")).toHaveLength(0);
  });

  it("holds while the launch is archived, even if its journey is live", async () => {
    const db = world({ journey: "active", archived: true });
    const id = dueStep(db);
    await processEmailJobs(ctx, 25, db);
    expect(db.raw("email_jobs", id)).toMatchObject({ status: "held", heldReason: "launch_archived" });
  });

  it("still removes gone, unverified and unsubscribed people before holding", async () => {
    const gone = world({ journey: "paused", signup: false });
    const goneId = dueStep(gone);
    await processEmailJobs(ctx, 25, gone);
    expect(gone.raw("email_jobs", goneId)).toBeUndefined();

    const unsubscribed = world({ journey: "paused" });
    unsubscribed.seed("email_suppressions", suppressionDocId("ten_A", "ada@example.test"), { tenantId: "ten_A", reason: "unsubscribe", createdAt: "2026-09-01T00:00:00Z" });
    const unsubId = dueStep(unsubscribed);
    await processEmailJobs(ctx, 25, unsubscribed);
    expect(unsubscribed.raw("email_jobs", unsubId)).toBeUndefined();
  });

  it("never claims a held step", async () => {
    const db = world({ journey: "paused" });
    const id = dueStep(db);
    await processEmailJobs(ctx, 25, db); // → held
    const again = await processEmailJobs(ctx, 25, db);
    expect(again.processed).toBe(0);
    expect(db.raw("email_jobs", id)).toMatchObject({ status: "held" });
  });

  it("lets the person leave when their step was removed, instead of failing and stranding them", async () => {
    const db = world({ journey: "active" });
    const id = dueStep(db, "email_removed");
    const r = await processEmailJobs(ctx, 25, db);
    expect(r.failed).toBe(0);
    expect(db.raw("email_jobs", id)).toMatchObject({ status: "done", endedReason: "step_removed" });
  });

  it("with the flag off, keeps the original behaviour (the step is marked done)", async () => {
    vi.stubEnv("WAITLIST_JOURNEY_HOLD_ON_PAUSE", "false");
    const db = world({ journey: "paused" });
    const id = dueStep(db);
    await processEmailJobs(ctx, 25, db);
    expect(db.raw("email_jobs", id)).toMatchObject({ status: "done" });
    expect(db.raw("email_jobs", id)!.heldReason).toBeUndefined();
  });
});

describe("joining a paused journey (engine move D1)", () => {
  it("enrols new signups into a paused journey so they get the welcome on resume; never a draft", async () => {
    const paused = world({ journey: "paused" });
    expect(await enrollSignupInActiveJourney(ctx, "camp1", { id: "s1", email: "ada@example.test" }, paused)).toBe("enqueued");

    const draft = world({ journey: "draft" });
    expect(await enrollSignupInActiveJourney(ctx, "camp1", { id: "s1", email: "ada@example.test" }, draft)).toBe("skipped");

    vi.stubEnv("WAITLIST_JOURNEY_HOLD_ON_PAUSE", "false");
    const off = world({ journey: "paused" });
    expect(await enrollSignupInActiveJourney(ctx, "camp1", { id: "s1", email: "ada@example.test" }, off)).toBe("skipped");
  });
});

describe("the journey engine stamp (engine move D1)", () => {
  it("stamps the original engine on the person it enrols, once", async () => {
    const db = world({ journey: "active" });
    expect(await enrolSignupInWaitlistJourney(ctx, "camp1", { id: "s1", email: "ada@example.test" }, db)).toBe("enqueued");
    expect(db.raw("signups", "s1")).toMatchObject({ journeyEngine: "legacy" });
  });

  it("never enrols someone the lifecycle engine emails, and doesn't stamp a skip", async () => {
    const db = world({ journey: "active" });
    db.seed("signups", "s2", { id: "s2", tenantId: "ten_A", campaignId: "camp1", status: "verified_active", email: "bo@example.test", journeyEngine: "lifecycle" });
    expect(await enrolSignupInWaitlistJourney(ctx, "camp1", { id: "s2", email: "bo@example.test", journeyEngine: "lifecycle" }, db)).toBe("skipped");
    expect(db.dump("email_jobs")).toHaveLength(0);

    const draft = world({ journey: "draft" });
    expect(await enrolSignupInWaitlistJourney(ctx, "camp1", { id: "s1", email: "ada@example.test" }, draft)).toBe("skipped");
    expect(draft.raw("signups", "s1")!.journeyEngine).toBeUndefined();
  });

  it("publishing skips people the lifecycle engine emails and stamps the rest", async () => {
    const db = world({ journey: "active" });
    db.seed("signups", "s2", { id: "s2", tenantId: "ten_A", campaignId: "camp1", status: "verified_active", email: "bo@example.test", journeyEngine: "lifecycle" });
    const journey = { id: "journey_camp1", ...db.raw("journeys", "journey_camp1") } as never;
    const r = await activateJourney(ctx, journey, db);
    expect(r.enqueued).toBe(1);
    expect(db.raw("email_jobs", "journey:journey_camp1:email1:s1")).toBeDefined();
    expect(db.raw("email_jobs", "journey:journey_camp1:email1:s2")).toBeUndefined();
    expect(db.raw("signups", "s1")).toMatchObject({ journeyEngine: "legacy" });
  });
});
