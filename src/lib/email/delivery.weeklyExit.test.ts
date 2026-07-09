import { vi, describe, it, expect, beforeEach } from "vitest";

// Spy on the weekly opt-in side-effect while keeping every other mailchimp
// export real (weeklyTag/campaignTag are used by broadcastAudienceTag). Kept in a
// SEPARATE file from delivery.test.ts so this module mock doesn't disturb the
// broadcast/journey suites there.
vi.mock("@/lib/mailchimp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailchimp")>();
  return { ...actual, syncSignupToWeekly: vi.fn(async () => ({ ok: true as const })) };
});

import { processEmailJobs, broadcastAudienceTag } from "./delivery";
import { syncSignupToWeekly } from "@/lib/mailchimp";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { JourneyGraph } from "@/lib/types/journey";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };

/** trigger → email1 → exit1. The exit's kind is parameterised. */
function graphWithExit(exitData: Record<string, unknown>): JourneyGraph {
  return {
    nodes: [
      { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      { id: "email1", type: "email", position: { x: 0, y: 0 }, data: { subject: "Hi", body: "Hello" } },
      { id: "exit1", type: "exit", position: { x: 0, y: 0 }, data: exitData },
    ],
    edges: [
      { id: "e0", source: "trigger", target: "email1", sourceHandle: null },
      { id: "e1", source: "email1", target: "exit1", sourceHandle: null },
    ],
  } as unknown as JourneyGraph;
}

function seed(db: FakeFirestore, exitData: Record<string, unknown>, opts: { signup?: boolean } = {}) {
  db.seed("journeys", "journey_camp1", {
    tenantId: "ten_A",
    campaignId: "camp1",
    status: "active",
    graph: graphWithExit(exitData),
    createdAt: "2026-06-19T00:00:00Z",
    updatedAt: "2026-06-19T00:00:00Z",
  });
  db.seed("campaigns", "camp1", {
    id: "camp1",
    tenantId: "ten_A",
    waitlistName: "Test Launch",
    archivedAt: null,
  });
  if (opts.signup !== false) {
    db.seed("signups", "s1", {
      id: "s1",
      tenantId: "ten_A",
      campaignId: "camp1",
      status: "verified_active",
      email: "a@b.com",
    });
  }
  // A due job landing directly on the exit node (as enqueueNext would produce
  // once resolveNextStep surfaces the weekly exit).
  const dedupe = "journey:journey_camp1:exit1:s1";
  db.seed("email_jobs", dedupe, {
    tenantId: "ten_A",
    campaignId: "camp1",
    type: "journey_step",
    status: "pending",
    dedupeKey: dedupe,
    scheduledAt: "2020-01-01T00:00:00.000Z", // due
    attempts: 0,
    claimedAt: null,
    emailSentAt: null,
    payload: { journeyId: "journey_camp1", nodeId: "exit1", signupId: "s1" },
    lastError: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    processedAt: null,
  });
  return dedupe;
}

describe("weekly Exit node — worker enrollment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("subscribes the recipient to the weekly audience and terminates (no follow-on)", async () => {
    const db = new FakeFirestore();
    const dedupe = seed(db, { exitTargetKind: "weekly", exitTargetLabel: "Weekly newsletter" });

    const r = await processEmailJobs(ctx, 25, db);

    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(syncSignupToWeekly).toHaveBeenCalledTimes(1);
    // Called for the right signup (arg order: ctx, campaign, signup).
    const [, campaignArg, signupArg] = (syncSignupToWeekly as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect((campaignArg as { id: string }).id).toBe("camp1");
    expect((signupArg as { id: string }).id).toBe("s1");
    // Exit is terminal: the job is marked done and NO new step is enqueued.
    expect(db.raw("email_jobs", dedupe)).toMatchObject({ status: "done" });
    expect(db.dump("email_jobs")).toHaveLength(1);
  });

  it("does NOT subscribe for a non-weekly (plain) exit — just terminates", async () => {
    const db = new FakeFirestore();
    seed(db, {}); // no exitTargetKind → plain terminal

    const r = await processEmailJobs(ctx, 25, db);

    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(syncSignupToWeekly).not.toHaveBeenCalled();
    expect(db.dump("email_jobs")).toHaveLength(1);
  });

  it("drops the job (no subscribe) when the recipient is gone", async () => {
    const db = new FakeFirestore();
    const dedupe = seed(db, { exitTargetKind: "weekly" }, { signup: false });

    const r = await processEmailJobs(ctx, 25, db);

    expect(r).toMatchObject({ processed: 1, failed: 0 });
    expect(syncSignupToWeekly).not.toHaveBeenCalled();
    // Dropped (deleted) so its dedupe key is freed.
    expect(db.raw("email_jobs", dedupe)).toBeUndefined();
  });
});

describe("broadcastAudienceTag", () => {
  it("targets the weekly segment for a weekly send, else the waitlist segment", () => {
    expect(broadcastAudienceTag("weekly", "camp1")).toBe("weekly-camp1");
    expect(broadcastAudienceTag("launch", "camp1")).toBe("waitlist-camp1");
    expect(broadcastAudienceTag(undefined, "camp1")).toBe("waitlist-camp1");
    expect(broadcastAudienceTag(null, "camp1")).toBe("waitlist-camp1");
  });
});
