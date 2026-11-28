import { describe, it, expect } from "vitest";
import { updateContentPlan, updateContentPlanNode } from "./workspaceContent";
import { FakeFirestore } from "./testing/fakeFirestore";
import { ContentPlanSchema, ContentGraphSchema } from "@/lib/types/contentPlan";
import type { TenantContext } from "./types";

/** Vizzy's draft is server-owned: only fillPlanNode (via updateContentPlanNode) writes it, and a
 *  canvas Save keeps the stored one, so an edit never loses it and a browser can't forge it. */

const TENANT = "ten_test";
const WS = "ws_1";
const PLAN = "plan_1";
const PATH = `workspaces/${WS}/content_plans`;
const T = "2020-01-01T00:00:00.000Z";
const ctx: TenantContext = { tenantId: TENANT, region: "us", source: "system" };

const node = {
  id: "n1",
  type: "spoke" as const,
  channel: "linkedin",
  role: "LinkedIn Post",
  position: { x: 0, y: 0 },
  body: "Vizzy's words.",
  status: "generated" as const,
};

function seed(db: FakeFirestore, nodes: Record<string, unknown>[]): void {
  db.seed(
    PATH,
    PLAN,
    ContentPlanSchema.parse({
      id: PLAN,
      tenantId: TENANT,
      workspaceId: WS,
      name: "P",
      strategy: { objective: "product_launch" },
      scope: {},
      knowledge: {},
      topology: {},
      graph: { nodes, edges: [] },
      createdAt: T,
      updatedAt: T,
    }),
  );
}

function nodes(db: FakeFirestore): Array<Record<string, unknown>> {
  const raw = db.raw(PATH, PLAN) as Record<string, unknown>;
  return ((raw["graph.nodes"] as unknown[]) ?? (raw.graph as { nodes: unknown[] }).nodes) as Array<Record<string, unknown>>;
}

describe("aiDraft through saves", () => {
  it("a canvas Save that edits the text keeps the stored draft", async () => {
    const db = new FakeFirestore();
    seed(db, [{ ...node, aiDraft: { body: "Vizzy's words.", at: T } }]);
    const edited = ContentGraphSchema.parse({ nodes: [{ ...node, body: "My words." }], edges: [] });
    await updateContentPlan(ctx, WS, PLAN, { graph: edited }, db);
    expect(nodes(db)[0]).toMatchObject({ body: "My words.", aiDraft: { body: "Vizzy's words.", at: T } });
  });

  it("a canvas Save can't set, change or clear a draft", async () => {
    const db = new FakeFirestore();
    seed(db, [node, { ...node, id: "n2", aiDraft: { body: "Stored.", at: T } }]);
    const forged = ContentGraphSchema.parse({
      nodes: [
        { ...node, aiDraft: { body: "Forged.", at: T } },
        { ...node, id: "n2", aiDraft: null },
        { ...node, id: "n3", aiDraft: { body: "New node forged.", at: T } },
      ],
      edges: [],
    });
    await updateContentPlan(ctx, WS, PLAN, { graph: forged }, db);
    const [n1, n2, n3] = nodes(db);
    expect(n1).not.toHaveProperty("aiDraft");
    expect(n2).toMatchObject({ aiDraft: { body: "Stored." } });
    expect(n3).not.toHaveProperty("aiDraft");
  });

  it("the node writer stores it", async () => {
    const db = new FakeFirestore();
    seed(db, [node]);
    const updated = await updateContentPlanNode(ctx, WS, PLAN, "n1", { body: "Fresh.", aiDraft: { body: "Fresh.", at: T }, made: { unstamped: "nothing_made" } }, db);
    expect(updated).toMatchObject({ aiDraft: { body: "Fresh.", at: T } });
  });
});
