import { describe, it, expect } from "vitest";
import {
  resolveNextStep,
  validateJourneyGraph,
  enrollSignupInActiveJourney,
  enqueueBroadcast,
  cancelScheduledBroadcast,
  processEmailJobs,
  processEmailJobsForAllTenants,
} from "./delivery";
import { enqueueEmailJob } from "./jobs";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { JourneyGraph } from "@/lib/types/journey";
import type { Tenant } from "@/lib/types/tenant";

function graph(
  nodes: Array<[string, "trigger" | "email" | "wait" | "condition", number?]>,
  // [source, target] or [source, target, sourceHandle]
  edges: Array<[string, string] | [string, string, string]>,
): JourneyGraph {
  return {
    nodes: nodes.map(([id, type, waitHours]) => ({
      id,
      type,
      position: { x: 0, y: 0 },
      data: type === "wait" ? { waitHours: waitHours ?? 0 } : { subject: id },
    })),
    edges: edges.map(([source, target, sourceHandle], i) => ({
      id: `e${i}`,
      source,
      target,
      sourceHandle: sourceHandle ?? null,
    })),
  };
}

describe("resolveNextStep (journey traversal)", () => {
  // trigger → email1 → wait(24) → email2
  const g = graph(
    [
      ["trigger", "trigger"],
      ["email1", "email"],
      ["wait1", "wait", 24],
      ["email2", "email"],
    ],
    [
      ["trigger", "email1"],
      ["email1", "wait1"],
      ["wait1", "email2"],
    ],
  );

  it("finds the first email after the trigger with zero delay", () => {
    expect(resolveNextStep(g, "trigger")).toEqual({
      nodeId: "email1",
      delayHours: 0,
      type: "email",
    });
  });

  it("sums wait nodes into the delay to the next email", () => {
    expect(resolveNextStep(g, "email1")).toEqual({
      nodeId: "email2",
      delayHours: 24,
      type: "email",
    });
  });

  it("returns null at a dead end", () => {
    expect(resolveNextStep(g, "email2")).toBeNull();
  });

  it("guards against cycles", () => {
    const loop = graph(
      [
        ["a", "email"],
        ["b", "email"],
      ],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    expect(resolveNextStep(loop, "a")).toEqual({
      nodeId: "b",
      delayHours: 0,
      type: "email",
    });
    expect(resolveNextStep(loop, "b")).toEqual({
      nodeId: "a",
      delayHours: 0,
      type: "email",
    });
  });

  it("stops at a condition node, summing the wait before it", () => {
    // email1 → wait(24) → cond
    const g2 = graph(
      [
        ["email1", "email"],
        ["wait1", "wait", 24],
        ["cond", "condition"],
      ],
      [
        ["email1", "wait1"],
        ["wait1", "cond"],
      ],
    );
    expect(resolveNextStep(g2, "email1")).toEqual({
      nodeId: "cond",
      delayHours: 24,
      type: "condition",
    });
  });

  it("follows the chosen branch handle out of a condition node", () => {
    // cond -(yes)-> wait(12) -> emailA ; cond -(default)-> emailB
    const g3 = graph(
      [
        ["cond", "condition"],
        ["wait1", "wait", 12],
        ["emailA", "email"],
        ["emailB", "email"],
      ],
      [
        ["cond", "wait1", "yes"],
        ["wait1", "emailA"],
        ["cond", "emailB", "default"],
      ],
    );
    expect(resolveNextStep(g3, "cond", "yes")).toEqual({
      nodeId: "emailA",
      delayHours: 12,
      type: "email",
    });
    expect(resolveNextStep(g3, "cond", "default")).toEqual({
      nodeId: "emailB",
      delayHours: 0,
      type: "email",
    });
  });

  it("returns null when the requested branch is unconnected", () => {
    const g4 = graph(
      [
        ["cond", "condition"],
        ["emailA", "email"],
      ],
      [["cond", "emailA", "yes"]],
    );
    // The "default" branch was never wired → dead end.
    expect(resolveNextStep(g4, "cond", "default")).toBeNull();
  });
});

describe("validateJourneyGraph (pre-activation guard)", () => {
  const emailNode = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    type: "email" as const,
    position: { x: 0, y: 0 },
    data: { subject: `subj-${id}`, body: `body-${id}`, ...over },
  });
  const plain = (
    id: string,
    type: "trigger" | "wait" | "condition",
    data: Record<string, unknown> = {},
  ) => ({ id, type, position: { x: 0, y: 0 }, data });
  const edge = (source: string, target: string) => ({
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: null,
  });

  it("rejects an empty graph (no entry node)", () => {
    expect(validateJourneyGraph({ nodes: [], edges: [] })).toEqual({
      ok: false,
      reason: "no_entry_node",
    });
  });

  it("rejects a lone trigger that leads nowhere (the canvas seed)", () => {
    const g: JourneyGraph = { nodes: [plain("t", "trigger")], edges: [] };
    expect(validateJourneyGraph(g)).toEqual({
      ok: false,
      reason: "entry_leads_nowhere",
    });
  });

  it("rejects a graph with no email node", () => {
    const g: JourneyGraph = {
      nodes: [plain("t", "trigger"), plain("c", "condition", { branches: [] })],
      edges: [edge("t", "c")],
    };
    expect(validateJourneyGraph(g)).toEqual({
      ok: false,
      reason: "no_email_node",
    });
  });

  it("rejects an email node missing subject/body content", () => {
    const g: JourneyGraph = {
      nodes: [plain("t", "trigger"), emailNode("e1", { subject: "", body: "" })],
      edges: [edge("t", "e1")],
    };
    expect(validateJourneyGraph(g)).toEqual({
      ok: false,
      reason: "email_missing_content",
    });
  });

  it("accepts a trigger → email with content", () => {
    const g: JourneyGraph = {
      nodes: [plain("t", "trigger"), emailNode("e1")],
      edges: [edge("t", "e1")],
    };
    expect(validateJourneyGraph(g)).toEqual({ ok: true });
  });

  it("accepts an entry email node with no explicit trigger", () => {
    const g: JourneyGraph = { nodes: [emailNode("e1")], edges: [] };
    expect(validateJourneyGraph(g)).toEqual({ ok: true });
  });
});

describe("enrollSignupInActiveJourney", () => {
  const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
  const activeGraph = graph(
    [
      ["trigger", "trigger"],
      ["email1", "email"],
    ],
    [["trigger", "email1"]],
  );
  const dedupe = "journey:journey_camp1:email1:s1";

  function seedJourney(
    db: FakeFirestore,
    status: string,
    g: JourneyGraph = activeGraph,
  ) {
    db.seed("journeys", "journey_camp1", {
      tenantId: "ten_A",
      campaignId: "camp1",
      status,
      graph: g,
      createdAt: "2026-06-19T00:00:00Z",
      updatedAt: "2026-06-19T00:00:00Z",
    });
  }

  it("enqueues the first step for a newly verified signup", async () => {
    const db = new FakeFirestore();
    seedJourney(db, "active");
    const r = await enrollSignupInActiveJourney(
      ctx,
      "camp1",
      { id: "s1", email: "a@b.com" },
      db,
    );
    expect(r).toBe("enqueued");
    expect(db.raw("email_jobs", dedupe)).toMatchObject({
      type: "journey_step",
      status: "pending",
      tenantId: "ten_A",
      payload: { journeyId: "journey_camp1", nodeId: "email1", signupId: "s1" },
    });
  });

  it("is idempotent — re-enrolling the same signup does not double-enqueue", async () => {
    const db = new FakeFirestore();
    seedJourney(db, "active");
    const first = await enrollSignupInActiveJourney(
      ctx,
      "camp1",
      { id: "s1", email: "a@b.com" },
      db,
    );
    const second = await enrollSignupInActiveJourney(
      ctx,
      "camp1",
      { id: "s1", email: "a@b.com" },
      db,
    );
    expect(first).toBe("enqueued");
    expect(second).toBe("skipped");
    expect(db.dump("email_jobs")).toHaveLength(1);
  });

  it("skips when the journey is not active (draft/paused)", async () => {
    const db = new FakeFirestore();
    seedJourney(db, "draft");
    const r = await enrollSignupInActiveJourney(
      ctx,
      "camp1",
      { id: "s1", email: "a@b.com" },
      db,
    );
    expect(r).toBe("skipped");
    expect(db.dump("email_jobs")).toHaveLength(0);
  });

  it("skips when there is no journey for the campaign", async () => {
    const db = new FakeFirestore();
    const r = await enrollSignupInActiveJourney(
      ctx,
      "camp1",
      { id: "s1", email: "a@b.com" },
      db,
    );
    expect(r).toBe("skipped");
  });

  it("skips a signup with no email", async () => {
    const db = new FakeFirestore();
    seedJourney(db, "active");
    const r = await enrollSignupInActiveJourney(
      ctx,
      "camp1",
      { id: "s1", email: null },
      db,
    );
    expect(r).toBe("skipped");
    expect(db.dump("email_jobs")).toHaveLength(0);
  });

  it("skips when the active journey has no reachable step", async () => {
    const db = new FakeFirestore();
    seedJourney(db, "active", graph([["trigger", "trigger"]], []));
    const r = await enrollSignupInActiveJourney(
      ctx,
      "camp1",
      { id: "s1", email: "a@b.com" },
      db,
    );
    expect(r).toBe("skipped");
  });
});

describe("processEmailJobs — recipient-gone jobs are dropped, not tombstoned", () => {
  const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
  const activeGraph = graph(
    [
      ["trigger", "trigger"],
      ["email1", "email"],
    ],
    [["trigger", "email1"]],
  );
  const dedupe = "journey:journey_camp1:email1:s1";

  function seedActiveJourney(db: FakeFirestore) {
    db.seed("journeys", "journey_camp1", {
      tenantId: "ten_A",
      campaignId: "camp1",
      status: "active",
      graph: activeGraph,
      createdAt: "2026-06-19T00:00:00Z",
      updatedAt: "2026-06-19T00:00:00Z",
    });
  }

  // A due first-step job from an earlier enrolment, whose recipient is gone.
  function seedDueJob(db: FakeFirestore) {
    db.seed("email_jobs", dedupe, {
      tenantId: "ten_A",
      campaignId: "camp1",
      type: "journey_step",
      status: "pending",
      dedupeKey: dedupe,
      scheduledAt: "2020-01-01T00:00:00.000Z", // due (in the past)
      attempts: 0,
      claimedAt: null,
      emailSentAt: null,
      payload: { journeyId: "journey_camp1", nodeId: "email1", signupId: "s1" },
      lastError: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      processedAt: null,
    });
  }

  it("deletes a step whose recipient no longer exists (frees the dedupe key)", async () => {
    const db = new FakeFirestore();
    seedActiveJourney(db);
    seedDueJob(db); // enrolled earlier; s1 since deleted (not seeded)

    const r = await processEmailJobs(ctx, 25, db);

    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    // GONE — not parked as a "done" tombstone that would block re-enrolment.
    expect(db.dump("email_jobs")).toHaveLength(0);
  });

  it("lets a re-created signup re-enroll once the stale job was dropped", async () => {
    const db = new FakeFirestore();
    seedActiveJourney(db);
    seedDueJob(db);

    // Worker runs while the recipient is gone → job dropped.
    await processEmailJobs(ctx, 25, db);
    expect(db.raw("email_jobs", dedupe)).toBeUndefined();

    // Contact re-signs-up with the same email → same deterministic id "s1".
    // Before the fix this returned "skipped" (the tombstone owned the dedupe
    // key forever); now the key is free, so enrolment succeeds and they get the
    // first email.
    const r = await enrollSignupInActiveJourney(
      ctx,
      "camp1",
      { id: "s1", email: "a@b.com" },
      db,
    );
    expect(r).toBe("enqueued");
    expect(db.raw("email_jobs", dedupe)).toMatchObject({ status: "pending" });
  });
});

describe("processEmailJobs — lifecycle (offboarding) email", () => {
  const ctx: TenantContext = { tenantId: "ten_L", region: "us", source: "system" };

  function seedJob(db: FakeFirestore, signupId: string) {
    db.seed("email_jobs", `offboard:${signupId}`, {
      tenantId: "ten_L",
      campaignId: "camp1",
      type: "lifecycle",
      status: "pending",
      dedupeKey: `offboard:${signupId}`,
      scheduledAt: "2020-01-01T00:00:00.000Z", // due
      attempts: 0,
      claimedAt: null,
      emailSentAt: null,
      payload: { signupId },
      lastError: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      processedAt: null,
    });
  }

  it("no-ops (done, no send) when the campaign's offboarding email is disabled", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "camp1", {
      tenantId: "ten_L",
      offboardingEmail: { enabled: false },
    });
    db.seed("signups", "s1", {
      tenantId: "ten_L",
      campaignId: "camp1",
      status: "offboarded",
      verified: true,
      email: "a@b.com",
    });
    seedJob(db, "s1");

    const r = await processEmailJobs(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({
      status: "done",
      emailSentAt: null, // never sent
    });
  });

  it("no-ops for an offboarded signup that was never verified (consent)", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "camp1", {
      tenantId: "ten_L",
      offboardingEmail: { enabled: true },
    });
    db.seed("signups", "s1", {
      tenantId: "ten_L",
      campaignId: "camp1",
      status: "offboarded",
      verified: false, // never confirmed their email → no outbound
      email: "a@b.com",
    });
    seedJob(db, "s1");

    const r = await processEmailJobs(ctx, 25, db);
    expect(r).toMatchObject({ done: 1 });
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({
      status: "done",
      emailSentAt: null,
    });
  });

  it("no-ops when the recipient is no longer offboarded", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "camp1", {
      tenantId: "ten_L",
      offboardingEmail: { enabled: true },
    });
    db.seed("signups", "s1", {
      tenantId: "ten_L",
      campaignId: "camp1",
      status: "verified_active", // re-activated before the job ran
      email: "a@b.com",
    });
    seedJob(db, "s1");

    const r = await processEmailJobs(ctx, 25, db);
    expect(r).toMatchObject({ done: 1 });
    expect(db.raw("email_jobs", "offboard:s1")).toMatchObject({
      status: "done",
      emailSentAt: null,
    });
  });

  it("dedupes a second offboard enqueue for the same signup (idempotent)", async () => {
    const db = new FakeFirestore();
    const a = await enqueueEmailJob(
      ctx,
      { type: "lifecycle", campaignId: "camp1", dedupeKey: "offboard:s9", payload: { signupId: "s9" } },
      db,
    );
    const b = await enqueueEmailJob(
      ctx,
      { type: "lifecycle", campaignId: "camp1", dedupeKey: "offboard:s9", payload: { signupId: "s9" } },
      db,
    );
    expect(a).toBe("enqueued");
    expect(b).toBe("duplicate");
  });
});

describe("processEmailJobsForAllTenants (multi-tenant fan-out)", () => {
  const tenants = [
    { id: "ten_us", region: "us" },
    { id: "ten_eu", region: "eu" },
    { id: "ten_asia", region: "asia" },
  ] as unknown as Tenant[];

  it("drains every tenant across all regions and aggregates totals", async () => {
    const seen: Array<{ tenantId: string; region: string }> = [];
    const r = await processEmailJobsForAllTenants(50, {
      listTenants: async () => tenants,
      drain: async (c) => {
        seen.push({ tenantId: c.tenantId, region: c.region });
        return { processed: 2, done: 2, failed: 0 };
      },
      syncStats: async () => {},
    });
    expect(seen).toEqual([
      { tenantId: "ten_us", region: "us" },
      { tenantId: "ten_eu", region: "eu" },
      { tenantId: "ten_asia", region: "asia" },
    ]);
    expect(r).toMatchObject({ tenants: 3, processed: 6, done: 6, failed: 0 });
  });

  it("isolates a failing tenant so the others still drain", async () => {
    const r = await processEmailJobsForAllTenants(50, {
      listTenants: async () => tenants,
      drain: async (c) => {
        if (c.region === "eu") throw new Error("eu_db_unavailable");
        return { processed: 1, done: 1, failed: 0 };
      },
      syncStats: async () => {},
    });
    expect(r.tenants).toBe(3);
    expect(r.processed).toBe(2); // us + asia only
    expect(r.done).toBe(2);
    expect(r.perTenant.find((p) => p.tenantId === "ten_eu")).toMatchObject({
      region: "eu",
      error: "eu_db_unavailable",
    });
    expect(r.perTenant.filter((p) => "done" in p)).toHaveLength(2);
  });

  it("passes the per-tenant limit through to the drain", async () => {
    const limits: number[] = [];
    await processEmailJobsForAllTenants(7, {
      listTenants: async () => [tenants[0]!],
      drain: async (_c, limit) => {
        limits.push(limit);
        return { processed: 0, done: 0, failed: 0 };
      },
      syncStats: async () => {},
    });
    expect(limits).toEqual([7]);
  });
});

describe("enqueueBroadcast — scheduling", () => {
  const ctx: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
  const key = "broadcast:bcast1";

  function seedJob(db: FakeFirestore, status: string, scheduledAt: string) {
    db.seed("email_jobs", key, {
      tenantId: "ten_B",
      campaignId: "camp1",
      type: "broadcast",
      status,
      dedupeKey: key,
      scheduledAt,
      attempts: status === "failed" ? 3 : 1,
      claimedAt: status === "processing" ? "2026-06-01T00:00:00.000Z" : null,
      emailSentAt: null,
      payload: { broadcastId: "bcast1" },
      lastError: status === "failed" ? "boom" : null,
      createdAt: "2026-06-01T00:00:00.000Z",
      processedAt: null,
    });
  }

  it("queues a future-scheduled job the worker leaves until due", async () => {
    const db = new FakeFirestore();
    const future = new Date(Date.now() + 24 * 3600_000).toISOString();
    const r = await enqueueBroadcast(ctx, "bcast1", "camp1", future, db);
    expect(r).toBe("enqueued");
    expect(db.raw("email_jobs", key)).toMatchObject({
      type: "broadcast",
      status: "pending",
      scheduledAt: future,
      payload: { broadcastId: "bcast1" },
    });
    // Not yet due → the worker drains nothing and the job stays pending.
    const drain = await processEmailJobs(ctx, 25, db);
    expect(drain.processed).toBe(0);
    expect(db.raw("email_jobs", key)).toMatchObject({ status: "pending" });
  });

  it("defaults to immediate (≈now) when no time is given", async () => {
    const db = new FakeFirestore();
    const before = Date.now();
    await enqueueBroadcast(ctx, "bcast1", "camp1", undefined, db);
    const job = db.raw("email_jobs", key)!;
    expect(job.status).toBe("pending");
    expect(Date.parse(job.scheduledAt as string)).toBeGreaterThanOrEqual(before);
  });

  it("re-times an already-pending (scheduled) job instead of duplicating", async () => {
    const db = new FakeFirestore();
    const t1 = new Date(Date.now() + 3600_000).toISOString();
    const t2 = new Date(Date.now() + 2 * 3600_000).toISOString();
    const first = await enqueueBroadcast(ctx, "bcast1", "camp1", t1, db);
    const second = await enqueueBroadcast(ctx, "bcast1", "camp1", t2, db);
    expect(first).toBe("enqueued");
    expect(second).toBe("enqueued");
    expect(db.dump("email_jobs")).toHaveLength(1);
    expect(db.raw("email_jobs", key)).toMatchObject({
      status: "pending",
      attempts: 0,
      scheduledAt: t2,
    });
  });

  it("resurrects a failed job (retry) with the new time", async () => {
    const db = new FakeFirestore();
    seedJob(db, "failed", "2026-01-01T00:00:00.000Z");
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = await enqueueBroadcast(ctx, "bcast1", "camp1", future, db);
    expect(r).toBe("enqueued");
    expect(db.raw("email_jobs", key)).toMatchObject({
      status: "pending",
      attempts: 0,
      scheduledAt: future,
      lastError: null,
    });
  });

  it("leaves an in-flight (processing) job untouched", async () => {
    const db = new FakeFirestore();
    seedJob(db, "processing", "2026-06-01T00:00:00.000Z");
    const r = await enqueueBroadcast(ctx, "bcast1", "camp1", undefined, db);
    expect(r).toBe("duplicate");
    expect(db.raw("email_jobs", key)).toMatchObject({
      status: "processing",
      attempts: 1,
    });
  });
});

describe("processEmailJobs — scheduled broadcast on an archived launch", () => {
  const ctx: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
  const key = "broadcast:bcast1";

  it("reconciles a scheduled broadcast to failed instead of leaving it stuck", async () => {
    const db = new FakeFirestore();
    db.seed("campaigns", "camp1", {
      tenantId: "ten_B",
      waitlistName: "Launch",
      archivedAt: "2026-06-01T00:00:00.000Z",
    });
    db.seed("broadcasts", "bcast1", {
      tenantId: "ten_B",
      campaignId: "camp1",
      name: "B",
      subject: "s",
      body: "b",
      status: "scheduled",
      scheduledAt: "2020-01-01T00:00:00.000Z",
      mailchimpCampaignId: null,
      stats: null,
      lastError: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      sentAt: null,
    });
    db.seed("email_jobs", key, {
      tenantId: "ten_B",
      campaignId: "camp1",
      type: "broadcast",
      status: "pending",
      dedupeKey: key,
      scheduledAt: "2020-01-01T00:00:00.000Z", // due (past)
      attempts: 0,
      claimedAt: null,
      emailSentAt: null,
      payload: { broadcastId: "bcast1" },
      lastError: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      processedAt: null,
    });

    const r = await processEmailJobs(ctx, 25, db);
    expect(r).toMatchObject({ processed: 1, done: 1, failed: 0 });
    // Not stuck on "scheduled" with a past time — surfaced as failed + cleared.
    expect(db.raw("broadcasts", "bcast1")).toMatchObject({
      status: "failed",
      lastError: "launch_archived",
      scheduledAt: null,
    });
    expect(db.raw("email_jobs", key)).toMatchObject({ status: "done" });
  });
});

describe("cancelScheduledBroadcast", () => {
  const ctx: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
  const key = "broadcast:bcast1";

  it("deletes a pending job and reports success", async () => {
    const db = new FakeFirestore();
    await enqueueBroadcast(
      ctx,
      "bcast1",
      "camp1",
      new Date(Date.now() + 3600_000).toISOString(),
      db,
    );
    const ok = await cancelScheduledBroadcast(ctx, "bcast1", db);
    expect(ok).toBe(true);
    expect(db.raw("email_jobs", key)).toBeUndefined();
  });

  it("is a no-op success when nothing is queued", async () => {
    const db = new FakeFirestore();
    const ok = await cancelScheduledBroadcast(ctx, "bcast1", db);
    expect(ok).toBe(true);
  });

  it("refuses (false) once the worker has claimed the job", async () => {
    const db = new FakeFirestore();
    db.seed("email_jobs", key, {
      tenantId: "ten_B",
      campaignId: "camp1",
      type: "broadcast",
      status: "processing",
      dedupeKey: key,
      scheduledAt: "2026-06-01T00:00:00.000Z",
      attempts: 1,
      claimedAt: "2026-06-01T00:00:00.000Z",
      emailSentAt: null,
      payload: { broadcastId: "bcast1" },
      lastError: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      processedAt: null,
    });
    const ok = await cancelScheduledBroadcast(ctx, "bcast1", db);
    expect(ok).toBe(false);
    expect(db.raw("email_jobs", key)).toMatchObject({ status: "processing" });
  });
});
