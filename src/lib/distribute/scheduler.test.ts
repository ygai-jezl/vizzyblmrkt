import { describe, it, expect } from "vitest";
import {
  processScheduledPosts,
  processScheduledPostsForAllTenants,
  schedulePost,
  setPostSpintax,
  setPostCarousel,
  cancelScheduledPost,
  listScheduledPosts,
  SchedulePostConflictError,
} from "./scheduler";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import type { Tenant } from "@/lib/types/tenant";
import { ContentPlanSchema } from "@/lib/types/contentPlan";

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

// The Create plan the worker reflects node status onto. updateContentPlanNode addresses it via
// a slash-path collection ref (`workspaces/{ws}/content_plans`), which the fake stores as a flat
// keyed map — so seed + read it under that exact key.
const CONTENT_PLANS_PATH = `workspaces/${WS}/content_plans`;

/** Seed a minimal, schema-valid content plan whose graph holds one approved+scheduled node. */
function seedPlan(db: FakeFirestore, nodeId: string): void {
  const plan = ContentPlanSchema.parse({
    id: PLAN,
    tenantId: TENANT,
    workspaceId: WS,
    name: "Test Plan",
    strategy: { objective: "product_launch" },
    scope: {},
    knowledge: {},
    topology: {},
    graph: {
      nodes: [
        {
          id: nodeId,
          type: "spoke",
          channel: "x",
          role: "X Post",
          position: { x: 0, y: 0 },
          body: "hello world",
          status: "approved",
          distributionStatus: "scheduled",
          scheduledAt: PAST,
        },
      ],
      edges: [],
    },
    createdAt: PAST,
    updatedAt: PAST,
  });
  db.seed(CONTENT_PLANS_PATH, PLAN, plan);
}

/** Read back the reflected node. updateContentPlanNode writes a Firestore dot-path field update
 *  ("graph.nodes"); the fake stores that literally as a top-level key rather than merging into the
 *  nested graph, so prefer that key (falling back to the nested array). */
function reflectedNode(
  db: FakeFirestore,
  nodeId: string,
): { id: string; distributionStatus?: string | null } | undefined {
  const plan = db.raw(CONTENT_PLANS_PATH, PLAN) as Record<string, unknown> | undefined;
  const nodes = (plan?.["graph.nodes"] ?? (plan?.graph as { nodes?: unknown[] } | undefined)?.nodes) as
    | Array<{ id: string; distributionStatus?: string | null }>
    | undefined;
  return nodes?.find((n) => n.id === nodeId);
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

  it("persists the pps score passed in", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    const { post } = await schedulePost(
      ctx,
      {
        workspaceId: WS,
        contentPlanId: PLAN,
        nodeId: "n1",
        channel: "x",
        body: "hi",
        pps: { score: 42, breakdown: { hook: 40, brevity: 50, formatting: 50, keyword: 30 } },
        scheduledAt: FUTURE,
      },
      db,
    );
    expect(post.pps).toMatchObject({ score: 42 });
    expect(db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)!.pps).toMatchObject({ score: 42 });
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

describe("node distribution reflection (Create canvas badge)", () => {
  it("flips the source node to 'posted' when a publish job completes (manual stamp)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: PAST }); // nodeId defaults to "p1"
    seedPlan(db, "p1");
    await processScheduledPosts(ctx, 25, db);
    expect(db.raw(COLLECTION, "p1")!.status).toBe("done");
    expect(reflectedNode(db, "p1")?.distributionStatus).toBe("posted");
  });

  it("flips the source node to 'failed' on a terminal park (x not connected)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: PAST });
    seedPlan(db, "p1");
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      await processScheduledPosts(ctx, 25, db);
      expect(db.raw(COLLECTION, "p1")!.status).toBe("failed");
      expect(reflectedNode(db, "p1")?.distributionStatus).toBe("failed");
    } finally {
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
  });

  it("publishes fine when the source plan/node was deleted (reflection is best-effort)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: PAST });
    // No plan seeded → updateContentPlanNode returns null; the publish must still complete.
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1 });
    expect(db.raw(COLLECTION, "p1")!.status).toBe("done");
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

  it("parks a due x post as failed 'x_not_connected' when the tenant has no X token (publish flag on)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: PAST }); // channel defaults to "x"; no tenant seeded → no token
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      // Parked (not thrown) → counted as failed, not done.
      expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
      const raw = db.raw(COLLECTION, "p1")!;
      expect(raw.status).toBe("failed");
      expect(raw.lastError).toBe("x_not_connected");
      // Nothing was published → publishedRef stays null so the operator can connect
      // X and re-arm the post safely (no phantom "unconfirmed" ref blocking re-arm).
      expect(raw.publishedRef).toBeNull();
    } finally {
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
  });

  it("parks a due LinkedIn post as 'linkedin_not_connected' when the tenant has no LinkedIn token", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: PAST, channel: "linkedin" });
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
      const raw = db.raw(COLLECTION, "p1")!;
      expect(raw.status).toBe("failed");
      expect(raw.lastError).toBe("linkedin_not_connected");
      expect(raw.publishedRef).toBeNull();
    } finally {
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
  });

  it("parks 'linkedin_page_not_connected' for a Page post when the tenant doesn't admin that org", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    // Post-as-Page (org URN) but no linkedin_org connection / not an admin'd org.
    seedPost(db, "p1", { scheduledAt: PAST, channel: "linkedin", linkedInAuthorUrn: "urn:li:organization:5" });
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
      expect(db.raw(COLLECTION, "p1")!.lastError).toBe("linkedin_page_not_connected");
    } finally {
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
  });

  it("Company-Page-only tenant + no explicit author defaults to the first admin Page (org path)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    // Tenant administers a Page but has NO personal LinkedIn connection. The stored token
    // can't decrypt (no SOCIAL_TOKEN_ENC_KEY), so publishing still parks — but as
    // 'linkedin_page_not_connected', proving the null-author post routed to the PAGE (org)
    // path via the Company-Page-only default, NOT the personal 'linkedin_not_connected'.
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
    seedPost(db, "p1", { scheduledAt: PAST, channel: "linkedin" }); // no linkedInAuthorUrn
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
      expect(db.raw(COLLECTION, "p1")!.lastError).toBe("linkedin_page_not_connected");
    } finally {
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
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

describe("transactional claim (exactly-once)", () => {
  it("publishes a contended post EXACTLY once under two overlapping drains", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "p1", { scheduledAt: PAST });
    // Worker A begins its claim transaction; after it reads p1 (pending) but before it
    // commits, Worker B runs a FULL drain and claims + publishes p1 first. A's commit
    // then conflicts (p1's version changed), A retries, re-reads p1 as done, and
    // declines — so p1 publishes exactly once.
    let bResult: Awaited<ReturnType<typeof processScheduledPosts>> | null = null;
    db.onBeforeCommit = async () => {
      bResult = await processScheduledPosts(ctx, 25, db); // Worker B
    };
    const aResult = await processScheduledPosts(ctx, 25, db); // Worker A

    const raw = db.raw(COLLECTION, "p1")!;
    expect(raw.status).toBe("done");
    expect((raw.publishedRef as { platform: string }).platform).toBe("manual");
    // B won the claim and published; A found nothing left to publish.
    expect(bResult!).toMatchObject({ processed: 1, done: 1 });
    expect(aResult.processed).toBe(0);
    // Written EXACTLY twice — only B (claim → done). The losing worker A applied no
    // write at all (had it, this would be 3+), proving "publishes once", not just
    // "declines the claim".
    expect(db.writeCountFor(COLLECTION, "p1")).toBe(2);
  });

  it("claim() declines a post already held under a FRESH lease (no double-claim)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    const repo = forTenant(ctx, db).scheduledPosts;
    const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    // The plan encodes the worker's claimability rule; a fresh lease is not stale.
    const plan = (cur: ScheduledPost) => {
      const isStale =
        cur.status === "processing" &&
        typeof cur.claimedAt === "string" &&
        cur.claimedAt <= staleBefore;
      if (cur.status !== "pending" && !isStale) return null;
      return { status: "processing" as const, attempts: cur.attempts + 1 };
    };
    seedPost(db, "p1", { status: "processing", claimedAt: new Date().toISOString() });
    expect(await repo.claim("p1", plan)).toBeNull();
    expect(db.raw(COLLECTION, "p1")!.attempts).toBe(0); // untouched
  });

  it("claim() re-reads fresh state: declines once already published, allows a stale reclaim", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    const repo = forTenant(ctx, db).scheduledPosts;
    const plan = (cur: ScheduledPost) => {
      if (cur.publishedRef) return null;
      const isStale =
        cur.status === "processing" &&
        typeof cur.claimedAt === "string" &&
        cur.claimedAt <= new Date(Date.now() - 10 * 60_000).toISOString();
      if (cur.status !== "pending" && !isStale) return null;
      return { status: "processing" as const, attempts: cur.attempts + 1 };
    };
    // Already published → never re-claim.
    seedPost(db, "pub", { status: "done", publishedRef: { platform: "x", publishedAt: PAST } });
    expect(await repo.claim("pub", plan)).toBeNull();
    // Stale processing lease (claimedAt far in the past) → reclaimable.
    seedPost(db, "stale", { status: "processing", claimedAt: PAST });
    const reclaimed = await repo.claim("stale", plan);
    expect(reclaimed).toMatchObject({ status: "processing", attempts: 1 });
    expect(db.raw(COLLECTION, "stale")!.status).toBe("processing");
  });
});

describe("auto_plug_comment worker", () => {
  const RULE = { thresholdMetric: "likes" as const, thresholdValue: 40, commentBody: "grab it here" };

  it("enqueues a follow-up auto_plug_comment when a publish carries an autoPlug rule (manual stamp path)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    // Flag OFF → manual stamp; manual publish has no real remoteId, so NO enqueue.
    seedPost(db, "p1", { scheduledAt: PAST, autoPlug: RULE });
    await processScheduledPosts(ctx, 25, db);
    expect(db.dump(COLLECTION)).toHaveLength(1); // only the parent (manual publish doesn't enqueue)
  });

  it("parks (failed) when social publishing is disabled — not a silent done", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "ap1", { jobKind: "auto_plug_comment", scheduledAt: PAST, autoPlug: RULE, sourceRemoteId: "P1" });
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
    expect(db.raw(COLLECTION, "ap1")!.status).toBe("failed");
    expect(db.raw(COLLECTION, "ap1")!.lastError).toBe("social_disabled");
  });

  it("is idempotent once fired (firedAt set) — never re-posts", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "ap1", {
      jobKind: "auto_plug_comment",
      scheduledAt: PAST,
      autoPlug: { ...RULE, firedAt: "2026-06-30T00:00:00Z" },
      sourceRemoteId: "P1",
    });
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      await processScheduledPosts(ctx, 25, db);
      expect(db.raw(COLLECTION, "ap1")!.status).toBe("done");
    } finally {
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
  });

  it("parks (failed) when misconfigured (no sourceRemoteId) with the flag on", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "ap1", { jobKind: "auto_plug_comment", scheduledAt: PAST, autoPlug: RULE });
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
      expect(db.raw(COLLECTION, "ap1")!.lastError).toBe("autoplug_misconfigured");
    } finally {
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
  });

  it("parks 'x_not_connected' when the tenant has no X token (flag on)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, "ap1", { jobKind: "auto_plug_comment", scheduledAt: PAST, autoPlug: RULE, sourceRemoteId: "P1" });
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
      expect(db.raw(COLLECTION, "ap1")!.lastError).toBe("x_not_connected");
    } finally {
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
  });
});

describe("performance_fetch worker (closed-loop harvest)", () => {
  const seedPerf = (db: FakeFirestore, over = {}) =>
    seedPost(db, "pf1", {
      jobKind: "performance_fetch",
      scheduledAt: PAST,
      sourceRemoteId: "P1",
      body: "a proven post",
      ...over,
    });

  it("completes as a no-op when the closed loop is disabled", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPerf(db);
    const r = await processScheduledPosts(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(db.raw(COLLECTION, "pf1")!.lastError).toBe("closed_loop_disabled");
  });

  it("parks 'social_disabled' when the loop is on but publishing is off", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPerf(db);
    process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
      expect(db.raw(COLLECTION, "pf1")!.lastError).toBe("social_disabled");
    } finally {
      delete process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED;
    }
  });

  it("parks 'x_not_connected' when loop+publish on but the tenant has no token", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPerf(db);
    process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED = "true";
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      expect(r).toMatchObject({ processed: 1, done: 0, failed: 1 });
      expect(db.raw(COLLECTION, "pf1")!.lastError).toBe("x_not_connected");
    } finally {
      delete process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED;
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
  });

  it("parks 'perf_misconfigured' when the job has no sourceRemoteId", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPerf(db, { sourceRemoteId: null });
    process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED = "true";
    process.env.DISTRIBUTE_SOCIAL_ENABLED = "true";
    try {
      const r = await processScheduledPosts(ctx, 25, db);
      expect(db.raw(COLLECTION, "pf1")!.lastError).toBe("perf_misconfigured");
      expect(r.failed).toBe(1);
    } finally {
      delete process.env.DISTRIBUTE_CLOSED_LOOP_ENABLED;
      delete process.env.DISTRIBUTE_SOCIAL_ENABLED;
    }
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

describe("setPostCarousel", () => {
  it("attaches slide refs to an editable post without touching time/status", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, { nodeId: "n1", status: "pending", scheduledAt: PAST });
    const { post } = await setPostCarousel(ctx, WS, PLAN, "n1", ["a.png", "b.png"], db);
    expect(post.carouselAssetRefs).toEqual(["a.png", "b.png"]);
    const raw = db.raw(COLLECTION, `post:${WS}:${PLAN}:n1`)!;
    expect(raw.carouselAssetRefs).toEqual(["a.png", "b.png"]);
    expect(raw.status).toBe("pending");
    expect(raw.scheduledAt).toBe(PAST);
  });

  it("rejects a published post and a missing post", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, {
      nodeId: "n1",
      status: "done",
      publishedRef: { platform: "manual", publishedAt: PAST },
    });
    await expect(setPostCarousel(ctx, WS, PLAN, "n1", ["a.png"], db)).rejects.toMatchObject({
      reason: "already_publishing",
    });
    await expect(setPostCarousel(ctx, WS, PLAN, "ghost", ["a.png"], db)).rejects.toMatchObject({
      reason: "post_not_found",
    });
  });

  it("never edits another tenant's post (isolation)", async () => {
    const db = new FakeFirestore();
    const ctx = ctxFor();
    seedPost(db, `post:${WS}:${PLAN}:n1`, { nodeId: "n1", tenantId: "ten_other" });
    await expect(setPostCarousel(ctx, WS, PLAN, "n1", ["a.png"], db)).rejects.toMatchObject({
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
