import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A published post counts what a person did with Vizzy's draft (learning loops step 5, 4.4),
 * through the real worker with the platforms stubbed: kept when its words went out as Vizzy wrote
 * them, edited otherwise, on every path to done (the manual one too), once per post, and nothing
 * for a post with no kept draft or no stamp.
 */

vi.mock("@/lib/social/tokenRefresh", () => ({ ensureFreshAccessToken: vi.fn(async () => "tok") }));
vi.mock("@/lib/social/x/client", () => ({
  publishToX: vi.fn(async () => ({ ok: true, remoteId: "x_1", url: "https://x.test/i/status/x_1" })),
  fetchXPublicMetrics: vi.fn(async () => ({ ok: false, reason: "unused" })),
}));
vi.mock("./feedback/reconcile", () => ({ reconcileTenantRewards: vi.fn(async () => 0) }));
vi.mock("./learnFromPostEdit", () => ({ learnFromPublishedPost: vi.fn(async () => "learned") }));

import { processScheduledPosts, schedulePost, setPostSpintax } from "./scheduler";
import { publishToX } from "@/lib/social/x/client";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { LoopStamp, Made } from "@/lib/types/loopStamp";
import { learnedFor } from "@/lib/loops/read";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { unusedForWeek } from "@/lib/loops/tally";
import { countMade, loopWeekOf } from "@/lib/loops/count";
import { pinOriginal, recordApprovals } from "@/lib/content/create/aiOriginals";
import { ContentPlanSchema, type ContentPlan } from "@/lib/types/contentPlan";
import type { ScheduledPostChannel } from "@/lib/types/scheduledPost";

const ctx: TenantContext = { tenantId: "ten_hearth", region: "us", source: "system" };
const COLLECTION = "campaign_scheduled_posts";
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const AI = "Three things Hearth Bakery checks before a new loaf goes on the shelf.";

async function scheduleDue(db: FakeFirestore, nodeId: string, channel: "x" | "linkedin", body: string, made: Made, aiBody: string | null = AI) {
  const { post } = await schedulePost(
    ctx,
    { workspaceId: "ws_1", contentPlanId: "plan_1", nodeId, channel, body, aiBody, scheduledBy: "uid_sam", scheduledAt: FUTURE, made },
    db,
  );
  db.seed(COLLECTION, post.id, { ...(db.raw(COLLECTION, post.id) as object), scheduledAt: PAST });
  return post.id;
}

const cellOf = (db: FakeFirestore) => (sumWeek(db, ctx.tenantId, loopWeekOf(new Date())) as { c?: Record<string, Record<string, unknown>> }).c?.content_write?.content_write;

beforeEach(() => {
  vi.stubEnv("LOOPS_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("publishing counts what happened to Vizzy's draft", () => {
  it("kept on a real X post, edited on a manual one, once each", async () => {
    vi.stubEnv("DISTRIBUTE_SOCIAL_ENABLED", "true");
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    const x = await scheduleDue(db, "n_x", "x", AI, stamp);
    expect(await processScheduledPosts(ctx, 25, db)).toMatchObject({ done: 1 });
    expect(cellOf(db)).toEqual({ v0: { none: { kept: 1 } } });

    vi.stubEnv("DISTRIBUTE_SOCIAL_ENABLED", "");
    await scheduleDue(db, "n_li", "linkedin", AI.replace("a new loaf", "the seasonal bake"), stamp);
    await processScheduledPosts(ctx, 25, db);
    expect(cellOf(db)).toEqual({ v0: { none: { kept: 1, edited: 1 } } });

    // A retry after the done stamp counts nothing more.
    db.seed(COLLECTION, x, { ...(db.raw(COLLECTION, x) as object), status: "pending", scheduledAt: PAST });
    await processScheduledPosts(ctx, 25, db);
    expect(cellOf(db)).toEqual({ v0: { none: { kept: 1, edited: 1 } } });
  });

  it("counts edited, not kept, when a person's spintax template went out in place of Vizzy's words", async () => {
    vi.stubEnv("DISTRIBUTE_SOCIAL_ENABLED", "true");
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    await scheduleDue(db, "n_x", "x", AI, stamp);
    await setPostSpintax(ctx, "ws_1", "plan_1", "n_x", "{Fresh sourdough|Warm rye} every Friday at Hearth Bakery, order by Thursday.", db);
    expect(await processScheduledPosts(ctx, 25, db)).toMatchObject({ done: 1 });
    // The words that went out are the template's variant, as the X call shows.
    expect(JSON.stringify(vi.mocked(publishToX).mock.calls[0]![0])).not.toContain("Three things Hearth Bakery checks");
    expect(cellOf(db)).toEqual({ v0: { none: { edited: 1 } } });
  });

  it("counts no_draft, never kept or edited, with no draft kept, and nothing for a person's own post", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    await scheduleDue(db, "n_1", "linkedin", AI, stamp, null);
    await scheduleDue(db, "n_2", "linkedin", AI, { unstamped: "person_wrote" });
    expect(await processScheduledPosts(ctx, 25, db)).toMatchObject({ done: 2 });
    // So the heartbeat can say "no draft kept" instead of a stall with no cause (4.4).
    expect(cellOf(db)).toEqual({ v0: { none: { no_draft: 1 } } });
  });

  it("counts the auto plug comment made once where its job is saved, rooted at its post", async () => {
    vi.stubEnv("DISTRIBUTE_SOCIAL_ENABLED", "true");
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    const id = await scheduleDue(db, "n_x", "x", AI, stamp);
    db.seed(COLLECTION, id, { ...(db.raw(COLLECTION, id) as object), autoPlug: { thresholdMetric: "likes", thresholdValue: 40, commentBody: "Order a loaf at Hearth Bakery" } });
    expect(await processScheduledPosts(ctx, 25, db)).toMatchObject({ done: 1 });
    const job = db.dump(COLLECTION).find((p) => p.jobKind === "auto_plug_comment")!;
    expect(job.made).toMatchObject({ kind: "auto_plug", root: (stamp as { made: string }).made });
    const week = sumWeek(db, ctx.tenantId, loopWeekOf(new Date())) as { c?: Record<string, Record<string, unknown>>; t?: Record<string, unknown> };
    expect(week.c?.auto_plug?.auto_plug).toEqual({ v0: { none: { made: 1 } } });
    expect(week.t).toMatchObject({ scheduled_post: { made: 1 } });
  });

  it("with LOOPS_ENABLED off counts nothing (decision 22)", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    vi.stubEnv("LOOPS_ENABLED", "");
    await scheduleDue(db, "n_1", "linkedin", AI, stamp);
    await processScheduledPosts(ctx, 25, db);
    expect(db.dump("loop_days")).toEqual([]);
  });

  it("drops a stamp kept while the switch was on when the post is re-armed with new words and the switch off, and keeps the same stamp handed back", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    const input = { workspaceId: "ws_1", contentPlanId: "plan_1", nodeId: "n_1", channel: "linkedin" as const, body: AI, aiBody: AI, scheduledBy: "uid_sam", scheduledAt: FUTURE };
    const { post } = await schedulePost(ctx, { ...input, made: stamp }, db);
    expect(db.raw(COLLECTION, post.id)).toMatchObject({ made: stamp });
    vi.stubEnv("LOOPS_ENABLED", "");
    // The node's words unchanged: its stamp comes back as it is, and stays.
    await schedulePost(ctx, { ...input, made: stamp }, db);
    expect(db.raw(COLLECTION, post.id)).toMatchObject({ made: stamp });
    // New words written with the switch off: the node has no stamp, so the post keeps none.
    const again = await schedulePost(ctx, { ...input, body: "Rye at noon.", made: { unstamped: "person_wrote" } }, db);
    expect(db.raw(COLLECTION, post.id)).not.toHaveProperty("made");
    expect(again.post).not.toHaveProperty("made");
  });
});

describe("a piece for another channel counts one answer, at its approval or its publish", () => {
  const person: TenantContext = { tenantId: ctx.tenantId, region: "us", source: "idtoken", userId: "uid_sam" };
  const LETTER = "Hearth Bakery's winter loaves are in. Rye, spelt and a fruit bread for the season.";

  /** A plan with one piece Vizzy wrote: made counted once, its AI original pinned, as fillPlanNode does. */
  async function piece(db: FakeFirestore, nodeId: string, channel: ScheduledPostChannel, made: Made): Promise<ContentPlan> {
    const plan = ContentPlanSchema.parse({
      id: "plan_1",
      tenantId: ctx.tenantId,
      workspaceId: "ws_1",
      name: "Winter loaves",
      strategy: { objective: "product_launch" },
      scope: {},
      knowledge: {},
      topology: {},
      graph: { nodes: [{ id: nodeId, type: "spoke", channel, role: "Piece", position: { x: 0, y: 0 }, body: LETTER, status: "generated", made }], edges: [] },
      createdAt: PAST,
      updatedAt: PAST,
    });
    db.seed("workspaces/ws_1/content_plans", "plan_1", plan);
    db.seed("workspaces", "ws_1", { tenantId: ctx.tenantId, name: "Hearth Bakery" });
    await countMade(ctx, "content_write", made, { type: "content_plan", db });
    await pinOriginal(person, { plan, node: plan.graph.nodes[0]!, body: LETTER }, { db });
    return plan;
  }
  const approve = (db: FakeFirestore, plan: ContentPlan) =>
    recordApprovals(person, { before: plan, after: { ...plan, graph: { ...plan.graph, nodes: [{ ...plan.graph.nodes[0]!, status: "approved" as const }] } } }, { db });
  /** Scheduled as the schedule route does (the node's stamp, no aiBody for these channels) and due now. */
  async function publishDue(db: FakeFirestore, nodeId: string, channel: ScheduledPostChannel, made: Made) {
    const { post } = await schedulePost(ctx, { workspaceId: "ws_1", contentPlanId: "plan_1", nodeId, channel, body: LETTER, scheduledAt: FUTURE, made }, db);
    db.seed(COLLECTION, post.id, { ...(db.raw(COLLECTION, post.id) as object), scheduledAt: PAST });
    expect(await processScheduledPosts(ctx, 25, db)).toMatchObject({ done: 1 });
  }

  beforeEach(() => vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "true"));

  it("a newsletter approved, then published by hand, counts kept once and no no_draft", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    const plan = await piece(db, "n_letter", "newsletter", stamp);
    expect(await approve(db, plan)).toBe(1);
    await publishDue(db, "n_letter", "newsletter", stamp);
    expect(cellOf(db)).toEqual({ v0: { none: { made: 1, kept: 1 } } });
  });

  it("an Instagram post approved and published leaves a second post nobody used as unused", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    const plan = await piece(db, "n_ig", "instagram", stamp);
    // A second post Vizzy wrote this week that nobody used.
    await countMade(ctx, "content_write", { ...(stamp as LoopStamp), at: new Date(Date.now() + 1).toISOString() }, { type: "content_plan", db });
    await approve(db, plan);
    await publishDue(db, "n_ig", "instagram", stamp);
    expect(cellOf(db)).toEqual({ v0: { none: { made: 2, kept: 1 } } });
    expect(unusedForWeek([sumWeek(db, ctx.tenantId, loopWeekOf(new Date())), undefined, undefined]).get("content_write")).toBe(1);
  });

  it("a piece published before anyone approved it counts no_draft at the publish, and its approval after counts nothing", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    const plan = await piece(db, "n_ig", "instagram", stamp);
    await publishDue(db, "n_ig", "instagram", stamp);
    expect(cellOf(db)).toEqual({ v0: { none: { made: 1, no_draft: 1 } } });
    expect(await approve(db, plan)).toBe(1);
    expect(cellOf(db)).toEqual({ v0: { none: { made: 1, no_draft: 1 } } });
  });

  it("with AI originals off, the publish is the answer: no_draft once", async () => {
    vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "");
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    const plan = await piece(db, "n_letter", "newsletter", stamp);
    expect(await approve(db, plan)).toBe(0);
    await publishDue(db, "n_letter", "newsletter", stamp);
    expect(cellOf(db)).toEqual({ v0: { none: { made: 1, no_draft: 1 } } });
    expect(db.dump("ai_originals")).toEqual([]);
  });

  it("with LOOPS_ENABLED off marks nothing on the AI original", async () => {
    const db = new FakeFirestore();
    const { stamp } = await learnedFor(ctx, "content_write");
    await piece(db, "n_letter", "newsletter", stamp);
    vi.stubEnv("LOOPS_ENABLED", "");
    await publishDue(db, "n_letter", "newsletter", stamp);
    expect(db.dump("ai_originals")[0]).not.toHaveProperty("publishedFor");
  });
});
