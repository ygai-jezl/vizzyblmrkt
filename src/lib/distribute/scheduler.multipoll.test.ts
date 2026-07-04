import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * MULTI-POLL: the Auto-Plug + closed-loop harvest jobs re-poll within a window instead
 * of firing/harvesting on a single shot, so a late-blooming post still triggers. This
 * drives the real worker (processScheduledPosts) with the two network calls stubbed:
 * ensureFreshAccessToken (token) + fetchXPublicMetrics (engagement). We exercise the
 * below-trigger paths — reschedule while inside the window, give up once past it.
 */

// Always hand the worker a usable token (refresh is unit-tested in tokenRefresh.test.ts).
vi.mock("@/lib/social/tokenRefresh", () => ({
  ensureFreshAccessToken: vi.fn(async () => "tok"),
}));

// Below-threshold engagement so both jobs stay under their trigger and re-poll.
const belowMetrics = { likes: 0, replies: 0, reposts: 0, quotes: 0, impressions: 0 };
vi.mock("@/lib/social/x/client", () => ({
  fetchXPublicMetrics: vi.fn(async () => ({ ok: true, metrics: belowMetrics })),
  publishToX: vi.fn(async () => ({ ok: false, reason: "unused" })),
}));

import { processScheduledPosts } from "./scheduler";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ScheduledPost } from "@/lib/types/scheduledPost";

const TENANT = "ten_test";
const COLLECTION = "campaign_scheduled_posts";
const PAST = "2020-01-01T00:00:00.000Z";
const ctx: TenantContext = { tenantId: TENANT, region: "us", source: "system" };
const HOUR = 60 * 60 * 1000;

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function seedPoll(db: FakeFirestore, id: string, over: Partial<ScheduledPost>): void {
  const base: ScheduledPost = {
    id,
    tenantId: TENANT,
    workspaceId: "ws_1",
    contentPlanId: "plan_1",
    nodeId: id,
    channel: "x",
    format: null,
    jobKind: "publish",
    status: "pending",
    dedupeKey: id,
    scheduledAt: PAST, // due now
    attempts: 0,
    claimedAt: null,
    body: "a post",
    sourceRemoteId: "P1",
    publishedRef: null,
    lastError: null,
    createdAt: PAST,
    processedAt: null,
  };
  const { id: _drop, ...data } = { ...base, ...over };
  db.seed(COLLECTION, id, data);
}

const RULE = { thresholdMetric: "likes" as const, thresholdValue: 40, commentBody: "grab it" };

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
  process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED = "true";
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.clearAllMocks();
});

describe("auto_plug_comment multi-poll", () => {
  it("re-arms for a later poll (not done/failed) when below threshold INSIDE the window", async () => {
    const db = new FakeFirestore();
    seedPoll(db, "ap1", {
      jobKind: "auto_plug_comment",
      autoPlug: RULE,
      createdAt: agoIso(1 * HOUR), // 1h ago — well inside the 72h window
      attempts: 2, // will be reset on reschedule
    });
    const r = await processScheduledPosts(ctx, 25, db);
    // Rescheduled = processed but neither done nor failed.
    expect(r).toMatchObject({ processed: 1, done: 0, failed: 0 });
    const doc = db.raw(COLLECTION, "ap1")!;
    expect(doc.status).toBe("pending");
    expect(doc.lastError).toBe("repoll");
    expect(doc.attempts).toBe(0); // reset — a re-poll is not a retry
    // Re-armed into the future so it isn't re-claimed in this drain.
    expect(Date.parse(doc.scheduledAt as string)).toBeGreaterThan(Date.now());
    expect(doc.autoPlug).toMatchObject({ commentBody: "grab it" }); // rule untouched, not fired
  });

  it("gives up immediately (never re-arms forever) when createdAt is unparseable", async () => {
    // Regression: a corrupt createdAt must NOT anchor the deadline to a moving `now`
    // (interval < window ⇒ infinite re-arm). It terminalizes as done/poll_window_unresolved.
    const db = new FakeFirestore();
    seedPoll(db, "ap1", { jobKind: "auto_plug_comment", autoPlug: RULE, createdAt: "not-a-date" });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    const doc = db.raw(COLLECTION, "ap1")!;
    expect(doc.status).toBe("done");
    expect(doc.lastError).toBe("poll_window_unresolved");
  });

  it("gives up (done, threshold_not_met) once the window has elapsed", async () => {
    const db = new FakeFirestore();
    seedPoll(db, "ap1", {
      jobKind: "auto_plug_comment",
      autoPlug: RULE,
      createdAt: agoIso(100 * HOUR), // past the 72h window
    });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    const doc = db.raw(COLLECTION, "ap1")!;
    expect(doc.status).toBe("done");
    expect(doc.lastError).toBe("threshold_not_met");
    expect(doc.processedAt).not.toBeNull();
  });
});

describe("performance_fetch multi-poll", () => {
  it("re-arms for a later poll when below the high-performer bar INSIDE the window", async () => {
    const db = new FakeFirestore();
    seedPoll(db, "pf1", {
      jobKind: "performance_fetch",
      createdAt: agoIso(1 * HOUR), // inside the 7d harvest window
    });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 0, failed: 0 });
    const doc = db.raw(COLLECTION, "pf1")!;
    expect(doc.status).toBe("pending");
    expect(doc.lastError).toBe("repoll");
    expect(Date.parse(doc.scheduledAt as string)).toBeGreaterThan(Date.now());
  });

  it("gives up (done, below_bar) once the harvest window has elapsed", async () => {
    const db = new FakeFirestore();
    seedPoll(db, "pf1", {
      jobKind: "performance_fetch",
      createdAt: agoIso(8 * 24 * HOUR), // past the 7d window
    });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    const doc = db.raw(COLLECTION, "pf1")!;
    expect(doc.status).toBe("done");
    expect(doc.lastError).toBe("below_bar");
  });
});
