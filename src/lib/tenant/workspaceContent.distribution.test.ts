import { describe, it, expect } from "vitest";
import { updateContentPlan } from "./workspaceContent";
import { FakeFirestore } from "./testing/fakeFirestore";
import { ContentPlanSchema, ContentGraphSchema } from "@/lib/types/contentPlan";
import type { TenantContext } from "./types";

const TENANT = "ten_test";
const WS = "ws_1";
const PLAN = "plan_1";
const PATH = `workspaces/${WS}/content_plans`;
const T = "2020-01-01T00:00:00.000Z";

function ctx(): TenantContext {
  return { tenantId: TENANT, region: "us", source: "system" };
}

const baseNode = {
  id: "n1",
  type: "spoke" as const,
  channel: "x",
  role: "X Post",
  position: { x: 0, y: 0 },
  body: "hi",
  status: "approved" as const,
};

function seedPlan(db: FakeFirestore, node: Record<string, unknown>): void {
  const plan = ContentPlanSchema.parse({
    id: PLAN,
    tenantId: TENANT,
    workspaceId: WS,
    name: "P",
    strategy: { objective: "product_launch" },
    scope: {},
    knowledge: {},
    topology: {},
    graph: { nodes: [node], edges: [] },
    createdAt: T,
    updatedAt: T,
  });
  db.seed(PATH, PLAN, plan);
}

function savedNodes(db: FakeFirestore): Array<Record<string, unknown>> {
  const raw = db.raw(PATH, PLAN) as { graph: { nodes: Array<Record<string, unknown>> } };
  return raw.graph.nodes;
}

describe("updateContentPlan — server-owned distribution guard", () => {
  it("preserves a worker-written distributionStatus when the canvas Saves a stale graph", async () => {
    const db = new FakeFirestore();
    // Server state: the node already published (the worker wrote this AFTER the canvas mounted).
    seedPlan(db, { ...baseNode, distributionStatus: "posted", scheduledAt: T });
    // The canvas Saves its whole in-memory graph — unaware of the posted write, and with an edit.
    const staleGraph = ContentGraphSchema.parse({
      nodes: [{ ...baseNode, body: "edited copy" }],
      edges: [],
    });
    await updateContentPlan(ctx(), WS, PLAN, { graph: staleGraph }, db);
    const n = savedNodes(db)[0]!;
    expect(n.distributionStatus).toBe("posted"); // guard kept the server-owned field
    expect(n.scheduledAt).toBe(T); // ...and its sibling scheduledAt
    expect(n.body).toBe("edited copy"); // ...while author edits still land
  });

  it("lets a brand-new node (no server match) pass through untouched", async () => {
    const db = new FakeFirestore();
    seedPlan(db, { ...baseNode }); // n1 has no distribution state
    const graph = ContentGraphSchema.parse({
      nodes: [{ ...baseNode }, { ...baseNode, id: "n2", role: "Second" }],
      edges: [],
    });
    await updateContentPlan(ctx(), WS, PLAN, { graph }, db);
    const nodes = savedNodes(db);
    expect(nodes.find((x) => x.id === "n2")).toBeTruthy();
    expect(nodes.find((x) => x.id === "n1")!.distributionStatus ?? null).toBeNull();
  });

  it("a status-only update (no graph) takes the fast path and doesn't touch nodes", async () => {
    const db = new FakeFirestore();
    seedPlan(db, { ...baseNode, distributionStatus: "scheduled", scheduledAt: T });
    await updateContentPlan(ctx(), WS, PLAN, { status: "ready" }, db);
    const raw = db.raw(PATH, PLAN) as { status: string; graph: { nodes: Array<Record<string, unknown>> } };
    expect(raw.status).toBe("ready");
    expect(raw.graph.nodes[0]!.distributionStatus).toBe("scheduled");
  });
});
