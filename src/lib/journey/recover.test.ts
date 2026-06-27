import { describe, it, expect, beforeEach } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { JourneyGraph } from "@/lib/types/journey";
import { recoverDeadEnds } from "./recover";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const CAMPAIGN = "camp1";
const JOURNEY = "journey_camp1";
const CONDITION_JOB = `journey:${JOURNEY}:c1:s1`;
const NEXT_JOB = `journey:${JOURNEY}:e1:s1`;

// A FIXED graph: condition c1 routes a no-voice/no-referral recipient to e1 via
// branch b1, with a default else-edge to ed.
const fixedGraph: JourneyGraph = {
  nodes: [
    {
      id: "c1",
      type: "condition",
      position: { x: 0, y: 0 },
      data: {
        branches: [
          {
            id: "b1",
            match: "all",
            conditions: [
              { field: "usedVoiceChat", operator: "is_false" },
              { field: "referralCount", operator: "eq", value: 0 },
            ],
          },
        ],
      },
    },
    { id: "e1", type: "email", position: { x: 0, y: 0 }, data: { subject: "next", body: "b" } },
    { id: "ed", type: "email", position: { x: 0, y: 0 }, data: { subject: "none", body: "b" } },
  ],
  edges: [
    { id: "eb1", source: "c1", target: "e1", sourceHandle: "b1" },
    { id: "edef", source: "c1", target: "ed", sourceHandle: "default" },
  ],
};

function seedAll(db: FakeFirestore, signupStatus = "verified_active", journeyStatus = "active") {
  db.seed("journeys", JOURNEY, {
    tenantId: "ten_A",
    campaignId: CAMPAIGN,
    status: journeyStatus,
    graph: fixedGraph,
    createdAt: "2026-06-24T00:00:00Z",
    updatedAt: "2026-06-26T00:00:00Z",
  });
  db.seed("campaigns", CAMPAIGN, { tenantId: "ten_A", waitlistName: "Camp 1" });
  db.seed("signups", "s1", {
    id: "s1",
    tenantId: "ten_A",
    campaignId: CAMPAIGN,
    status: signupStatus,
    verified: signupStatus === "verified_active",
    email: "a@b.com",
    amountReferred: 0,
    score: 0,
    referralToken: "tok",
    referralLink: "https://x/y",
    createdAt: "2026-06-24T00:00:00Z",
  });
  // The stranded "done" condition job (no successor enqueued).
  db.seed("email_jobs", CONDITION_JOB, {
    tenantId: "ten_A",
    campaignId: CAMPAIGN,
    type: "journey_step",
    status: "done",
    dedupeKey: CONDITION_JOB,
    scheduledAt: "2026-06-25T00:00:00Z",
    attempts: 1,
    claimedAt: "2026-06-25T00:00:01Z",
    emailSentAt: null,
    payload: { journeyId: JOURNEY, nodeId: "c1", signupId: "s1" },
    lastError: null,
    createdAt: "2026-06-24T00:00:00Z",
    processedAt: "2026-06-25T00:00:01Z",
  });
}

describe("recoverDeadEnds", () => {
  let db: FakeFirestore;
  beforeEach(() => {
    db = new FakeFirestore();
  });

  it("dry-run reports the would-be next step without writing", async () => {
    seedAll(db);
    const res = await recoverDeadEnds(ctx, CAMPAIGN, JOURNEY, { apply: false, db });
    expect(res.strandedFound).toBe(1);
    expect(res.items[0]).toMatchObject({ signupId: "s1", decision: "would_enqueue", handle: "b1", nextNodeId: "e1" });
    expect(db.raw("email_jobs", NEXT_JOB)).toBeUndefined();
  });

  it("apply enqueues the resolved next step", async () => {
    seedAll(db);
    const res = await recoverDeadEnds(ctx, CAMPAIGN, JOURNEY, { apply: true, db });
    expect(res.items[0]).toMatchObject({ decision: "enqueued", nextNodeId: "e1" });
    expect(db.raw("email_jobs", NEXT_JOB)).toMatchObject({
      type: "journey_step",
      status: "pending",
      payload: { journeyId: JOURNEY, nodeId: "e1", signupId: "s1" },
    });
  });

  it("is idempotent — a second apply skips (successor already exists)", async () => {
    seedAll(db);
    await recoverDeadEnds(ctx, CAMPAIGN, JOURNEY, { apply: true, db });
    const second = await recoverDeadEnds(ctx, CAMPAIGN, JOURNEY, { apply: true, db });
    expect(second.items[0]!.decision).toBe("skip_exists");
  });

  it("skips a recipient who is no longer verified_active", async () => {
    seedAll(db, "unverified");
    const res = await recoverDeadEnds(ctx, CAMPAIGN, JOURNEY, { apply: true, db });
    expect(res.items[0]!.decision).toBe("skip_recipient");
    expect(db.raw("email_jobs", NEXT_JOB)).toBeUndefined();
  });

  it("does nothing for a non-active journey", async () => {
    seedAll(db, "verified_active", "paused");
    const res = await recoverDeadEnds(ctx, CAMPAIGN, JOURNEY, { apply: true, db });
    expect(res.status).toBe("journey_paused");
    expect(res.strandedFound).toBe(0);
  });
});
