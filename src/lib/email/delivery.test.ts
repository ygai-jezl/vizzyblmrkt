import { describe, it, expect } from "vitest";
import {
  resolveNextStep,
  validateJourneyGraph,
  enrollSignupInActiveJourney,
  processEmailJobs,
  processEmailJobsForAllTenants,
} from "./delivery";
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
