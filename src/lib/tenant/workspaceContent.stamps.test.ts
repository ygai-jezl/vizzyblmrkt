import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContentPlan, updateContentPlan, updateContentPlanNode } from "./workspaceContent";
import { FakeFirestore } from "./testing/fakeFirestore";
import { ContentGraphSchema, ContentPlanSchema } from "@/lib/types/contentPlan";
import type { LoopStamp } from "@/lib/types/loopStamp";
import type { TenantContext } from "./types";

/**
 * A node's stamps (learning loops step 5, 4.2 of the plan for steps 4 and 5): only
 * updateContentPlanNode writes them, a canvas Save keeps the stored ones so it can't forge or
 * clear one, and a new plan's nodes have none. Off, nothing is written. Hearth Bakery is made up.
 */

const ctx: TenantContext = { tenantId: "ten_hearth", region: "eu", source: "system" };
const WS = "ws_1";
const PLAN = "plan_1";
const PATH = `workspaces/${WS}/content_plans`;
const T = "2027-01-15T10:00:00.000Z";

const words: LoopStamp = { made: "m1.content_write.0.n", kind: "content_write", scope: "content_write", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: T };
const image: LoopStamp = { ...words, made: "m1.image_style.natural_photo.1.l", kind: "post_image", scope: "image_style.natural_photo", v: 1, arm: "learned", items: ["look1"] };

const node = { id: "n1", type: "spoke" as const, channel: "linkedin", role: "LinkedIn Post", position: { x: 0, y: 0 }, body: "", status: "empty" as const };

function seed(db: FakeFirestore, nodes: Record<string, unknown>[]): void {
  db.seed(
    PATH,
    PLAN,
    ContentPlanSchema.parse({
      id: PLAN,
      tenantId: ctx.tenantId,
      workspaceId: WS,
      name: "Saturday loaves",
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

function stored(db: FakeFirestore): Array<Record<string, unknown>> {
  const raw = db.raw(PATH, PLAN) as Record<string, unknown>;
  return ((raw["graph.nodes"] as unknown[]) ?? (raw.graph as { nodes: unknown[] }).nodes) as Array<Record<string, unknown>>;
}

afterEach(() => vi.unstubAllEnvs());

describe("with LOOPS_ENABLED off", () => {
  it("writes no stamp, so a node is exactly as before (decision 22)", async () => {
    const db = new FakeFirestore();
    seed(db, [node]);
    await updateContentPlanNode(ctx, WS, PLAN, "n1", { body: "Fresh sourdough at 8.", status: "generated", made: words }, db);
    expect(stored(db)[0]).not.toHaveProperty("made");
    expect(stored(db)[0]).not.toHaveProperty("imageMade");
  });
});

describe("with LOOPS_ENABLED on", () => {
  beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));

  it("keeps the words' and the image's stamps apart, each set only by the write that changes it", async () => {
    const db = new FakeFirestore();
    seed(db, [node]);
    await updateContentPlanNode(ctx, WS, PLAN, "n1", { body: "Fresh sourdough at 8.", status: "generated", made: words }, db);
    await updateContentPlanNode(ctx, WS, PLAN, "n1", { imageAssetRef: "loaf.png", made: image }, db);
    await updateContentPlanNode(ctx, WS, PLAN, "n1", { scheduledAt: T, distributionStatus: "scheduled", made: { unstamped: "records_where" } }, db);
    expect(stored(db)[0]).toMatchObject({ made: words, imageMade: image });
    // A patch can't set a stamp by spreading one in.
    await updateContentPlanNode(ctx, WS, PLAN, "n1", { brief: "Shorter", made: { unstamped: "dates_only" }, ...({ imageMade: words } as object) }, db);
    expect(stored(db)[0]).toMatchObject({ made: words, imageMade: image });
    await updateContentPlanNode(ctx, WS, PLAN, "n1", { imageAssetRef: null, made: { unstamped: "removes_image" } }, db);
    expect(stored(db)[0]).toMatchObject({ made: words });
    expect(stored(db)[0]).not.toHaveProperty("imageMade");
  });

  it("keeps the stored stamps through a canvas Save, which can't forge, change or clear one", async () => {
    const db = new FakeFirestore();
    seed(db, [
      { ...node, body: "Fresh sourdough at 8.", status: "generated", made: words, imageMade: image },
      { ...node, id: "n2" },
    ]);
    const forged = ContentGraphSchema.parse({
      nodes: [
        { ...node, body: "My words.", status: "generated" },
        { ...node, id: "n2", made: { ...words, made: "m1.content_write.7.l", v: 7, arm: "learned" } },
        { ...node, id: "n3", made: words, imageMade: image },
      ],
      edges: [],
    });
    await updateContentPlan(ctx, WS, PLAN, { graph: forged }, db);
    const [n1, n2, n3] = stored(db);
    expect(n1).toMatchObject({ body: "My words.", made: words, imageMade: image });
    expect(n2).not.toHaveProperty("made");
    expect(n3).not.toHaveProperty("made");
    expect(n3).not.toHaveProperty("imageMade");
  });

  it("creates a plan with no node stamps, keeping only the plan's own", async () => {
    const db = new FakeFirestore();
    const plan = await createContentPlan(
      ctx,
      WS,
      {
        name: "From chat",
        status: "draft",
        strategy: { objective: "product_launch" },
        scope: {},
        knowledge: {},
        topology: {},
        graph: { nodes: [{ ...node, made: words, imageMade: image }], edges: [] },
        made: { ...words, made: "m1.canvas.content_plan.0.n", kind: "canvas.content_plan", scope: "canvas.content_plan", by: "vizzy" },
      } as never,
      db,
    );
    expect(plan.graph.nodes[0]).not.toHaveProperty("made");
    expect(plan.graph.nodes[0]).not.toHaveProperty("imageMade");
    expect(plan.made).toMatchObject({ kind: "canvas.content_plan", by: "vizzy" });
  });

  it("drops a stored stamp that no longer parses instead of failing the plan", () => {
    const parsed = ContentPlanSchema.parse({
      id: PLAN,
      tenantId: ctx.tenantId,
      workspaceId: WS,
      name: "P",
      strategy: { objective: "product_launch" },
      scope: {},
      knowledge: {},
      topology: {},
      graph: { nodes: [{ ...node, made: { made: "not a made id" } }], edges: [] },
      createdAt: T,
      updatedAt: T,
    });
    expect(parsed.graph.nodes[0]!.made).toBeUndefined();
  });
});
