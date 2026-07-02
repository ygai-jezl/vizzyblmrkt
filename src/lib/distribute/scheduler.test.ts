import { describe, it, expect } from "vitest";
import {
  processScheduledPosts,
  processScheduledPostsForAllTenants,
  schedulePost,
  setPostSpintax,
  cancelScheduledPost,
  listScheduledPosts,
  SchedulePostConflictError,
} from "./scheduler";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import type { Tenant } from "@/lib/types/tenant";

const TENANT = "ten_test";
const WS = "ws_1";
const PLAN = "plan_1";
const COLLECTION = "campaign_scheduled_posts";
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

function ctxFor(tenantId = TENANT): TenantContext {
  return { tenantId, region: "us", source: "system" };
}

/** Seed a full post doc directly (bypassing the repo — simulates prior state / other tenants). */
function seedPost(
  db: FakeFirestore,
  id: string,
  overrides: Partial<ScheduledPost> & { tenantId?: string } = {},
): void {
  const base: ScheduledPost = {
    id,
    tenantId: TENANT,
    workspaceId: WS,
    contentPlanId: PLAN,
    nodeId: id,
    channel: "x",
    format: null,
    jobKind: "publish",
    status: "pending",
    dedupeKey: id,
    scheduledAt: PAST,
    attempts: 0,
    claimedAt: null,
    body: "hello world",
    publishedRef: null,
    lastError: null,
    createdAt: PAST,
    processedAt: null,
  };
  // Stored docs never carry `id` (the doc key is the id); mirror that.
  const { id: _drop, ...data } = { ...base, ...overrides };
  db.seed(COLLECTION, id, data);
}

describe("schedulePost", () => {
  it("creates a pending post for a node (idempotent doc id = dedupeKey)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    const { status, post } = await schedulePost(
      ctx,
      { workspaceId: WS, contentPlanId: PLAN, nodeId: "n1", channel: "x", body: "hi", scheduledAt: FUTURE },
      db,
    );
    expect(status).toBe("scheduled");
    expect(post.dedupeKey).toBe(`post:${WS}:${PLAN}:n1`);
    expect(post.status).toBe("pending");
    expect(post.tenantId).toBe(TENANT);
    expect(db.dump(COLLECTION)).toHaveLength(1);
  });

  it("re-arms an existing pending post to the new time (no duplicate)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    const t1 = "2999-01-01T00:00:00.000Z";
    const t2 = "2999-06-01T00:00:00.000Z";
    await schedulePost(ctx, { workspaceId: WS, contentPlanId: PLAN, nodeId: "n1", channel: "x", body: "v1", scheduledAt: t1 }, db);
    const again = await schedulePost(ctx, { workspaceId: WS, contentPlanId: PLAN, nodeId: "n1", channel: "x", body: "v2", scheduledAt: t2 }, db);
    expect(again.post.scheduledAt).toBe(t2);
    expect(again.post.body).toBe("v2"); // payload refreshed
    expect(db.dump(COLLECTION)).toHaveLength(1); // still one doc
  });

  it("re-arms a failed post", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, { nodeId: "n1", status: "failed", attempts: 3, lastError: "boom" });
    const r = await schedulePost(ctx, { workspaceId: WS, contentPlanId: PLAN, nodeId: "n1", channel: "x", body: "retry", scheduledAt: FUTURE }, db);
    expect(r.post.status).toBe("pending");
    expect(r.post.attempts).toBe(0);
    expect(r.post.lastError).toBeNull();
  });

  it("refuses to re-arm a failed post that already published (publishedRef set)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    // Phase-4 shape: published to the channel, then a later step failed.
    seedPost(db, `post:${WS}:${PLAN}:n1`, {
      nodeId: "n1",
      status: "failed",
      publishedRef: { platform: "x", remoteId: "1", publishedAt: PAST },
    });
    await expect(
      schedulePost(ctx, { workspaceId: WS, contentPlanId: PLAN, nodeId: "n1", channel: "x", body: "x", scheduledAt: FUTURE }, db),
    ).rejects.toBeInstanceOf(SchedulePostConflictError);
  });

  it("refuses to re-arm a post that is already publishing/done", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, {
      nodeId: "n1",
      status: "done",
      publishedRef: { platform: "manual", publishedAt: PAST },
    });
    await expect(
      schedulePost(ctx, { workspaceId: WS, contentPlanId: PLAN, nodeId: "n1", channel: "x", body: "x", scheduledAt: FUTURE }, db),
    ).rejects.toBeInstanceOf(SchedulePostConflictError);
  });
});

describe("processScheduledPosts", () => {
  it("publishes a due pending post (manual stamp) and marks it done", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: PAST });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    const raw = db.raw(COLLECTION, "p1")!;
    expect(raw.status).toBe("done");
    expect((raw.publishedRef as { platform: string }).platform).toBe("manual");
    expect(raw.processedAt).not.toBeNull();
  });

  it("does not pick up a post scheduled in the future", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: FUTURE });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r.processed).toBe(0);
    expect(db.raw(COLLECTION, "p1")!.status).toBe("pending");
  });

  it("is idempotent: a second drain does not re-process a done post", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: PAST });
    await processScheduledPosts(ctx, 25, db);
    const second = await processScheduledPosts(ctx, 25, db);
    expect(second.processed).toBe(0);
  });

  it("retries a failing job up to MAX_ATTEMPTS then parks it failed", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    // auto_dm is not implemented in phase 1 → dispatch throws → retry path.
    seedPost(db, "p1", { jobKind: "auto_dm", scheduledAt: PAST });
    const r1 = await processScheduledPosts(ctx, 25, db);
    expect(r1.failed).toBe(1);
    expect(db.raw(COLLECTION, "p1")!.status).toBe("pending"); // attempt 1 → retry
    await processScheduledPosts(ctx, 25, db); // attempt 2 → retry
    expect(db.raw(COLLECTION, "p1")!.status).toBe("pending");
    await processScheduledPosts(ctx, 25, db); // attempt 3 → exhausted
    const raw = db.raw(COLLECTION, "p1")!;
    expect(raw.status).toBe("failed");
    expect(raw.attempts).toBe(3);
    expect(raw.lastError).toContain("not implemented");
  });

  it("reclaims a stale 'processing' claim (crashed worker) and publishes it", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    seedPost(db, "p1", { status: "processing", claimedAt: stale, scheduledAt: PAST });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r.done).toBe(1);
    expect(db.raw(COLLECTION, "p1")!.status).toBe("done");
  });

  it("does not reclaim a fresh 'processing' claim (another worker holds it)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    const fresh = new Date().toISOString();
    seedPost(db, "p1", { status: "processing", claimedAt: fresh, scheduledAt: PAST });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r.processed).toBe(0);
    expect(db.raw(COLLECTION, "p1")!.status).toBe("processing");
  });

  it("publish is idempotent: a re-claim after publishedRef is set never re-posts", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    seedPost(db, "p1", {
      status: "processing",
      claimedAt: stale,
      scheduledAt: PAST,
      publishedRef: { platform: "x", remoteId: "123", publishedAt: PAST },
    });
    await processScheduledPosts(ctx, 25, db);
    const raw = db.raw(COLLECTION, "p1")!;
    expect(raw.status).toBe("done");
    // The original publishedRef is preserved — NOT overwritten with a manual stamp.
    expect((raw.publishedRef as { platform: string; remoteId: string }).platform).toBe("x");
    expect((raw.publishedRef as { remoteId: string }).remoteId).toBe("123");
  });

  it("renders a spintax variant at publish (recycling)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    await schedulePost(
      ctx,
      { workspaceId: WS, contentPlanId: PLAN, nodeId: "n1", channel: "x", body: "base", spintaxSource: "{Hi|Hello}", scheduledAt: PAST },
      db,
    );
    await processScheduledPosts(ctx, 25, db);
    const raw = db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)!;
    expect(raw.status).toBe("done");
    expect(["Hi", "Hello"]).toContain(raw.renderedVariant);
  });

  it("never processes another tenant's post (isolation)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "mine", { scheduledAt: PAST });
    seedPost(db, "theirs", { tenantId: "ten_other", scheduledAt: PAST });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r.processed).toBe(1);
    expect(db.raw(COLLECTION, "theirs")!.status).toBe("pending"); // untouched
  });
});

describe("cancelScheduledPost", () => {
  it("deletes a pending post", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, { nodeId: "n1" });
    const ok = await cancelScheduledPost(ctx, WS, PLAN, "n1", db);
    expect(ok).toBe(true);
    expect(db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)).toBeUndefined();
  });

  it("refuses to cancel a post already being published", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, { nodeId: "n1", status: "processing", claimedAt: new Date().toISOString() });
    const ok = await cancelScheduledPost(ctx, WS, PLAN, "n1", db);
    expect(ok).toBe(false);
    expect(db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)).toBeDefined();
  });

  it("refuses to cancel a failed post that already published (publishedRef set)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, {
      nodeId: "n1",
      status: "failed",
      publishedRef: { platform: "x", remoteId: "1", publishedAt: PAST },
    });
    const ok = await cancelScheduledPost(ctx, WS, PLAN, "n1", db);
    expect(ok).toBe(false);
    expect(db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)).toBeDefined();
  });

  it("treats an absent post as already cancelled", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    expect(await cancelScheduledPost(ctx, WS, PLAN, "ghost", db)).toBe(true);
  });
});

describe("listScheduledPosts", () => {
  it("returns only this tenant's posts, soonest scheduled first", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "a", { nodeId: "a", scheduledAt: "2999-03-01T00:00:00.000Z" });
    seedPost(db, "b", { nodeId: "b", scheduledAt: "2999-01-01T00:00:00.000Z" });
    seedPost(db, "other", { tenantId: "ten_other", scheduledAt: "2999-02-01T00:00:00.000Z" });
    const posts = await listScheduledPosts(ctx, WS, db);
    expect(posts.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("setPostSpintax", () => {
  it("updates the template + clears the render WITHOUT touching time/status", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    // Overdue-but-pending (scheduledAt in the past) — must stay editable.
    seedPost(db, `post:${WS}:${PLAN}:n1`, {
      nodeId: "n1",
      status: "pending",
      scheduledAt: PAST,
      renderedVariant: "old",
    });
    const { post } = await setPostSpintax(ctx, WS, PLAN, "n1", "{a|b}", db);
    expect(post.spintaxSource).toBe("{a|b}");
    const raw = db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)!;
    expect(raw.spintaxSource).toBe("{a|b}");
    expect(raw.renderedVariant).toBeNull();
    expect(raw.status).toBe("pending"); // unchanged
    expect(raw.scheduledAt).toBe(PAST); // time untouched (no must_be_future path)
  });

  it("edits a FAILED post's template without un-failing / re-queuing it", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, {
      nodeId: "n1",
      status: "failed",
      attempts: 3,
      lastError: "boom",
    });
    await setPostSpintax(ctx, WS, PLAN, "n1", "{a|b}", db);
    const raw = db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)!;
    expect(raw.status).toBe("failed"); // NOT resurrected to pending
    expect(raw.attempts).toBe(3);
    expect(raw.lastError).toBe("boom");
    expect(raw.spintaxSource).toBe("{a|b}");
  });

  it("clears the template with null", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, { nodeId: "n1", spintaxSource: "{a|b}" });
    await setPostSpintax(ctx, WS, PLAN, "n1", null, db);
    expect(db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)!.spintaxSource).toBeNull();
  });

  it("rejects editing a published/done post", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, {
      nodeId: "n1",
      status: "done",
      publishedRef: { platform: "manual", publishedAt: PAST },
    });
    await expect(setPostSpintax(ctx, WS, PLAN, "n1", "{a|b}", db)).rejects.toMatchObject({
      reason: "already_publishing",
    });
  });

  it("rejects a missing post", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    await expect(setPostSpintax(ctx, WS, PLAN, "ghost", "{a|b}", db)).rejects.toMatchObject({
      reason: "post_not_found",
    });
  });
});

describe("processScheduledPostsForAllTenants", () => {
  it("fans out across tenants and isolates a per-tenant failure", async () => {
    const tenants: Tenant[] = [
      { id: "t_ok", region: "us" } as Tenant,
      { id: "t_bad", region: "eu" } as Tenant,
    ];
    const r = await processScheduledPostsForAllTenants(100, {
      listTenants: async () => tenants,
      drain: async (ctx) => {
        if (ctx.tenantId === "t_bad") throw new Error("region down");
        return { processed: 2, done: 2, failed: 0 };
      },
    });
    expect(r.tenants).toBe(2);
    expect(r.processed).toBe(2);
    expect(r.perTenant).toHaveLength(2);
    expect(r.perTenant.find((p) => p.tenantId === "t_bad")).toMatchObject({ error: "region down" });
  });
});
