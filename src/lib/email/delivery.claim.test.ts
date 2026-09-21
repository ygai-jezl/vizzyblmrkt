import { vi, describe, it, expect, beforeEach } from "vitest";

// The weekly Exit side-effect is the probe for "processed exactly once": it is an
// external call with no idempotency of its own. Kept in a SEPARATE file from
// delivery.test.ts so this module mock doesn't disturb the suites there.
vi.mock("@/lib/mailchimp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailchimp")>();
  return { ...actual, syncSignupToWeekly: vi.fn(async () => ({ ok: true as const })) };
});

import { processEmailJobs, processEmailJobsForAllTenants } from "./delivery";
import { syncSignupToWeekly } from "@/lib/mailchimp";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { JourneyGraph } from "@/lib/types/journey";
import type { Tenant } from "@/lib/types/tenant";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
const DEDUPE = "journey:journey_camp1:exit1:s1";

const graph = {
  nodes: [
    { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "exit1", type: "exit", position: { x: 0, y: 0 }, data: { exitTargetKind: "weekly" } },
  ],
  edges: [{ id: "e0", source: "trigger", target: "exit1", sourceHandle: null }],
} as unknown as JourneyGraph;

/** An active journey whose due job lands on a weekly Exit for signup s1. */
function seed(db: FakeFirestore, job: Record<string, unknown> = {}) {
  db.seed("journeys", "journey_camp1", {
    tenantId: "ten_A",
    campaignId: "camp1",
    status: "active",
    graph,
    createdAt: "2026-06-19T00:00:00Z",
    updatedAt: "2026-06-19T00:00:00Z",
  });
  db.seed("campaigns", "camp1", {
    id: "camp1",
    tenantId: "ten_A",
    waitlistName: "Test Launch",
    archivedAt: null,
  });
  db.seed("signups", "s1", {
    id: "s1",
    tenantId: "ten_A",
    campaignId: "camp1",
    status: "verified_active",
    email: "a@b.com",
  });
  db.seed("email_jobs", DEDUPE, {
    tenantId: "ten_A",
    campaignId: "camp1",
    type: "journey_step",
    status: "pending",
    dedupeKey: DEDUPE,
    scheduledAt: "2020-01-01T00:00:00.000Z", // due
    attempts: 0,
    claimedAt: null,
    emailSentAt: null,
    payload: { journeyId: "journey_camp1", nodeId: "exit1", signupId: "s1" },
    lastError: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    processedAt: null,
    ...job,
  });
}

describe("processEmailJobs — transactional claim (exactly once)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("processes a due job exactly once when two drains overlap", async () => {
    const db = new FakeFirestore();
    seed(db);

    const [a, b] = await Promise.all([
      processEmailJobs(ctx, 25, db),
      processEmailJobs(ctx, 25, db),
    ]);

    expect(syncSignupToWeekly).toHaveBeenCalledTimes(1);
    expect(a.processed + b.processed).toBe(1);
    expect(db.raw("email_jobs", DEDUPE)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("skips a job another worker claimed between the query and the claim", async () => {
    const db = new FakeFirestore();
    seed(db);
    // A concurrent worker commits its claim after our transaction read the job
    // but before our commit: our transaction must re-run, see the fresh lease,
    // and decline.
    db.onBeforeCommit = async () => {
      await forTenant(ctx, db).emailJobs.update(DEDUPE, {
        status: "processing",
        attempts: 1,
        claimedAt: new Date().toISOString(),
      });
    };

    const r = await processEmailJobs(ctx, 25, db);

    expect(r).toMatchObject({ processed: 0, done: 0, failed: 0 });
    expect(syncSignupToWeekly).not.toHaveBeenCalled();
    expect(db.raw("email_jobs", DEDUPE)).toMatchObject({ status: "processing", attempts: 1 });
  });

  it("reclaims a stale claim left by a crashed worker, once", async () => {
    const db = new FakeFirestore();
    seed(db, {
      status: "processing",
      attempts: 1,
      claimedAt: "2020-01-01T00:00:00.000Z", // long past the lease
    });

    const r = await processEmailJobs(ctx, 25, db);

    expect(r).toMatchObject({ processed: 1, done: 1 });
    expect(syncSignupToWeekly).toHaveBeenCalledTimes(1);
    expect(db.raw("email_jobs", DEDUPE)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("leaves a freshly claimed job alone", async () => {
    const db = new FakeFirestore();
    seed(db, { status: "processing", attempts: 1, claimedAt: new Date().toISOString() });

    const r = await processEmailJobs(ctx, 25, db);

    expect(r.processed).toBe(0);
    expect(syncSignupToWeekly).not.toHaveBeenCalled();
  });

  it("claims nothing once the run deadline has passed", async () => {
    const db = new FakeFirestore();
    seed(db);

    const r = await processEmailJobs(ctx, 25, db, { deadlineAt: Date.now() - 1 });

    expect(r).toMatchObject({ processed: 0, done: 0, failed: 0 });
    expect(syncSignupToWeekly).not.toHaveBeenCalled();
    expect(db.raw("email_jobs", DEDUPE)).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("processEmailJobsForAllTenants — run budget", () => {
  const tenants = [
    { id: "ten_1", region: "us" },
    { id: "ten_2", region: "eu" },
    { id: "ten_3", region: "asia" },
  ] as unknown as Tenant[];

  it("passes the run deadline to each tenant's drain", async () => {
    const deadlines: Array<number | undefined> = [];
    await processEmailJobsForAllTenants(10, {
      listTenants: async () => tenants,
      drain: async (_c, _limit, opts) => {
        deadlines.push(opts?.deadlineAt);
        return { processed: 0, done: 0, failed: 0 };
      },
      syncStats: async () => {},
      budgetMs: 5_000,
      now: () => 1_000,
    });
    expect(deadlines).toEqual([6_000, 6_000, 6_000]);
  });

  it("defers the remaining tenants once the budget is spent", async () => {
    let t = 0;
    const drained: string[] = [];
    const r = await processEmailJobsForAllTenants(10, {
      listTenants: async () => tenants,
      drain: async (c) => {
        drained.push(c.tenantId);
        t += 60_000; // each tenant's drain takes a minute
        return { processed: 1, done: 1, failed: 0 };
      },
      syncStats: async () => {},
      budgetMs: 90_000,
      now: () => t,
    });
    expect(drained).toEqual(["ten_1", "ten_2"]);
    expect(r).toMatchObject({ tenants: 3, processed: 2, deferred: 1 });
  });

  it("skips the stats refresh once the budget is spent", async () => {
    let t = 0;
    const synced: string[] = [];
    await processEmailJobsForAllTenants(10, {
      listTenants: async () => [tenants[0]!],
      drain: async () => {
        t += 100_000;
        return { processed: 0, done: 0, failed: 0 };
      },
      syncStats: async (c) => {
        synced.push(c.tenantId);
      },
      budgetMs: 90_000,
      now: () => t,
    });
    expect(synced).toEqual([]);
  });
});
