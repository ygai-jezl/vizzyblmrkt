import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Post results and learning from post edits, through the real worker with the platforms
 * stubbed: Vizzy's draft and who scheduled it ride from schedulePost to the post, then to the
 * results job; a LinkedIn post records which page it went out as; and learning runs after a
 * publish, never before.
 */

vi.mock("@/lib/social/tokenRefresh", () => ({ ensureFreshAccessToken: vi.fn(async () => "tok") }));
vi.mock("@/lib/social/x/client", () => ({
  publishToX: vi.fn(async () => ({ ok: true, remoteId: "x_1", url: "https://x.test/i/status/x_1" })),
  fetchXPublicMetrics: vi.fn(async () => ({ ok: false, reason: "unused" })),
}));
vi.mock("@/lib/social/linkedin/client", () => ({
  postToLinkedIn: vi.fn(async () => ({ ok: true, remoteId: "urn:li:share:1", url: "https://linkedin.test/feed/1" })),
}));
vi.mock("./feedback/reconcile", () => ({ reconcileTenantRewards: vi.fn(async () => 0) }));
vi.mock("./learnFromPostEdit", () => ({ learnFromPublishedPost: vi.fn(async () => "learned") }));

import { processScheduledPosts, schedulePost } from "./scheduler";
import { learnFromPublishedPost } from "./learnFromPostEdit";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

const TENANT = "ten_test";
const COLLECTION = "campaign_scheduled_posts";
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const ctx: TenantContext = { tenantId: TENANT, region: "us", source: "system" };
const AI = "Three questions we ask before building a new feature.";
const POSTED = "Three questions we ask before building any feature.";

function seedTenant(db: FakeFirestore): void {
  db.seed("tenants", TENANT, {
    tenantName: "T",
    rootDomain: "t.example",
    status: "active",
    region: "us",
    allowedOrigins: [],
    billingTier: "free",
    ownerId: "u1",
    createdAt: PAST,
    updatedAt: PAST,
    socialConnections: {
      linkedin_org: {
        platform: "linkedin_org",
        enc: { ct: "x", iv: "y", tag: "z" },
        orgs: [{ urn: "urn:li:organization:5", name: "Acme" }],
        connectedAt: PAST,
      },
    },
  });
}

async function scheduleDue(db: FakeFirestore, channel: "x" | "linkedin", extra: Record<string, unknown> = {}) {
  const { post } = await schedulePost(
    ctx,
    {
      workspaceId: "ws_1",
      contentPlanId: "plan_1",
      nodeId: `n_${channel}`,
      channel,
      body: POSTED,
      aiBody: AI,
      scheduledBy: "uid_1",
      scheduledAt: FUTURE, made: { unstamped: "person_wrote" },
      ...extra,
    },
    db,
  );
  // Make it due now.
  db.seed(COLLECTION, post.id, { ...(db.raw(COLLECTION, post.id) as object), scheduledAt: PAST });
  return post.id;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
  process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED = "true";
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.clearAllMocks();
});

describe("schedulePost keeps Vizzy's draft and who scheduled it", () => {
  it("on create and on a re-arm", async () => {
    const db = new FakeFirestore();
    const id = await scheduleDue(db, "x");
    expect(db.raw(COLLECTION, id)).toMatchObject({ aiBody: AI, scheduledBy: "uid_1" });
    await schedulePost(
      ctx,
      { workspaceId: "ws_1", contentPlanId: "plan_1", nodeId: "n_x", channel: "x", body: POSTED, scheduledAt: FUTURE, made: { unstamped: "person_wrote" } },
      db,
    );
    // A re-arm without a draft (switch off at the route) clears it rather than keeping a stale one.
    expect(db.raw(COLLECTION, id)).toMatchObject({ aiBody: null, scheduledBy: null });
  });
});

describe("after publishing", () => {
  it("an X post's results job carries the draft, and learning runs once with the post", async () => {
    const db = new FakeFirestore();
    const id = await scheduleDue(db, "x");
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ done: 1 });
    expect(db.raw(COLLECTION, `perf:${id}`)).toMatchObject({ jobKind: "performance_fetch", aiBody: AI, body: POSTED });
    expect(learnFromPublishedPost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(learnFromPublishedPost).mock.calls[0]![1]).toMatchObject({ aiBody: AI, body: POSTED, scheduledBy: "uid_1" });
  });

  it("a LinkedIn page post records the page it went out as", async () => {
    const db = new FakeFirestore();
    seedTenant(db);
    const id = await scheduleDue(db, "linkedin", { linkedInAuthorUrn: "urn:li:organization:5" });
    await processScheduledPosts(ctx, 25, db);
    expect(db.raw(COLLECTION, id)).toMatchObject({
      status: "done",
      publishedRef: { platform: "linkedin", authorUrn: "urn:li:organization:5" },
    });
    expect(learnFromPublishedPost).toHaveBeenCalledTimes(1);
  });

  it("doesn't learn from a post that failed to publish", async () => {
    const { publishToX } = await import("@/lib/social/x/client");
    vi.mocked(publishToX).mockResolvedValueOnce({ ok: false, reason: "x_api_403" });
    const db = new FakeFirestore();
    await scheduleDue(db, "x");
    await processScheduledPosts(ctx, 25, db);
    expect(learnFromPublishedPost).not.toHaveBeenCalled();
  });
});
