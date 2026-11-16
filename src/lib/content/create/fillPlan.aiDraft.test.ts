import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));

import { fillPlanNode } from "./fillPlan";
import type { generateNode } from "./generateNode";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { ContentPlanSchema, type ContentPlan } from "@/lib/types/contentPlan";
import type { TenantContext } from "@/lib/tenant/types";

/** fillPlanNode keeps Vizzy's draft of a LinkedIn or X post, and hands drafting the person's
 *  post edit preferences, each only with its switch on. */

const TENANT = "ten_test";
const WS = "ws_1";
const PLAN = "plan_1";
const PATH = `workspaces/${WS}/content_plans`;
const T = "2020-01-01T00:00:00.000Z";
const ctx: TenantContext = { tenantId: TENANT, region: "us", source: "system", userId: "uid_1" };

function seed(db: FakeFirestore, channel: string): ContentPlan {
  const plan = ContentPlanSchema.parse({
    id: PLAN,
    tenantId: TENANT,
    workspaceId: WS,
    name: "P",
    strategy: { objective: "product_launch" },
    scope: {},
    knowledge: {},
    topology: {},
    graph: { nodes: [{ id: "n1", type: "spoke", channel, role: "Post", position: { x: 0, y: 0 } }], edges: [] },
    createdAt: T,
    updatedAt: T,
  });
  db.seed(PATH, PLAN, plan);
  return plan;
}

const generate = vi.fn(async () => ({
  body: "Vizzy's post.",
  placeholderValues: {},
  status: "generated" as const,
  warnings: [],
  format: "linkedin-post",
})) as unknown as typeof generateNode;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function fill(channel: string, preferences = vi.fn(async () => [] as string[])) {
  const db = new FakeFirestore();
  const plan = seed(db, channel);
  const r = await fillPlanNode(ctx, { workspace: { id: WS }, plan, nodeId: "n1" }, { db, generate, preferences });
  return { r, preferences };
}

describe("fillPlanNode and Vizzy's draft", () => {
  it("keeps no draft with the switch off", async () => {
    const { r } = await fill("linkedin");
    expect(r.ok && r.node.aiDraft).toBeFalsy();
  });

  it("keeps the draft of a LinkedIn or X post with the switch on, and not of a blog", async () => {
    vi.stubEnv("CONTENT_AI_DRAFT_KEPT_ENABLED", "true");
    const li = await fill("linkedin");
    expect(li.r.ok && li.r.node.aiDraft).toMatchObject({ body: "Vizzy's post." });
    const blog = await fill("blog");
    expect(blog.r.ok && blog.r.node.aiDraft).toBeFalsy();
  });

  it("passes the person's preferences to drafting only when there are some", async () => {
    await fill("x", vi.fn(async () => ["Cuts emoji."]));
    expect(vi.mocked(generate).mock.calls[0]![0]).toMatchObject({ editPreferences: ["Cuts emoji."] });
    await fill("x");
    expect(vi.mocked(generate).mock.calls[1]![0]).not.toHaveProperty("editPreferences");
  });
});
