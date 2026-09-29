import { describe, it, expect } from "vitest";
import { getContentPlan } from "./workspaceContent";
import { FakeFirestore } from "./testing/fakeFirestore";
import { ContentPlanSchema } from "@/lib/types/contentPlan";
import type { TenantContext } from "./types";

const TENANT = "ten_test";
const WS = "ws_1";
const PLAN = "plan_1";
const PATH = `workspaces/${WS}/content_plans`;
const T = "2020-01-01T00:00:00.000Z";

const ctx: TenantContext = { tenantId: TENANT, region: "us", source: "system" };

const button = { id: "b1", kind: "button", label: "Get started", href: "https://example.com/start", align: "center", bg: "#4f46e5", color: "#ffffff", radius: 6 };

/** A plan with one email node whose layout has two buttons, stored as a later build might have left it. */
function seed(db: FakeFirestore, styleSources: [unknown, unknown]): void {
  const plan = ContentPlanSchema.parse({
    id: PLAN,
    tenantId: TENANT,
    workspaceId: WS,
    name: "Welcome sequence",
    strategy: { objective: "product_launch" },
    scope: {},
    knowledge: {},
    topology: {},
    graph: {
      nodes: [
        {
          id: "e1",
          type: "email",
          channel: "newsletter",
          role: "Email 1",
          position: { x: 0, y: 0 },
          subject: "Welcome",
          layout: { blocks: [{ id: "t1", kind: "text", role: "copy", html: "<p>Hi there.</p>" }, button, { ...button, id: "b2" }] },
        },
      ],
      edges: [],
    },
    createdAt: T,
    updatedAt: T,
  });
  // Write the raw values past the schema, as a rolled-back build's doc would hold them.
  const blocks = plan.graph.nodes[0]!.layout!.blocks as Array<Record<string, unknown>>;
  blocks[1]!.styleSource = styleSources[0];
  blocks[2]!.styleSource = styleSources[1];
  db.seed(PATH, PLAN, plan);
}

describe("getContentPlan — a layout button's styleSource", () => {
  it("a value from a later build reads as absent, so the plan still loads with the button as built", async () => {
    const db = new FakeFirestore();
    seed(db, ["tinted", "own"]);
    const plan = await getContentPlan(ctx, WS, PLAN, db);
    expect(plan).not.toBeNull();
    const blocks = plan!.graph.nodes[0]!.layout!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(["text", "button", "button"]);
    expect(blocks[1]).toMatchObject({ bg: "#4f46e5", color: "#ffffff", radius: 6 });
    expect(blocks[1]!.kind === "button" && blocks[1]!.styleSource).toBeUndefined();
    expect(blocks[2]).toMatchObject({ styleSource: "own" });
  });

  it("a malformed value never hides the plan", async () => {
    for (const bad of [7, null, { mode: "own" }]) {
      const db = new FakeFirestore();
      seed(db, [bad, "email_style"]);
      const plan = await getContentPlan(ctx, WS, PLAN, db);
      expect(plan?.graph.nodes[0]!.layout!.blocks[2]).toMatchObject({ styleSource: "email_style" });
    }
  });
});
