import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./activeBrandVoice", () => ({ activeBrandVoiceText: vi.fn(async () => null) }));

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { ContentPlanSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { aiOriginalId, type AiOriginalDoc } from "@/lib/types/aiOriginal";
import { deleteContentPlan } from "@/lib/tenant/workspaceContent";
import { agentContentPlan } from "@/lib/content/agentApi";
import { fillPlanNode } from "./fillPlan";
import type { generateNode } from "./generateNode";
import { followCheck, newlyApproved, pinOriginal, readOriginal, recordApproval, recordApprovals, stampOf } from "./aiOriginals";
import { aiOriginalView } from "./aiOriginalView";
import { loopWeekOf } from "@/lib/loops/count";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import type { LoopStamp } from "@/lib/types/loopStamp";

/** The AI original of each piece: pinned when written, paired with the approved copy, gone with its plan. */

const TENANT = "ten_A";
const WS = "ws_1";
const PLAN = "plan_1";
const PATH = `workspaces/${WS}/content_plans`;
const T = "2026-11-20T10:00:00.000Z";
const person: TenantContext = { tenantId: TENANT, region: "us", source: "idtoken", userId: "uid_1" };
const autopilot: TenantContext = { tenantId: TENANT, region: "us", source: "system" };
const other: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken", userId: "uid_9" };
const ORIGINALS = "ai_originals";

const ARTICLE = "# Tracking\n\nIntro.\n\n## Why\n\nBuyers ask AI first.\n\n## How\n\nA tool asks every day.";

function seedPlan(db: FakeFirestore, nodes: Array<{ id: string; type: string; channel: string; body?: string; status?: string }>): ContentPlan {
  const plan = ContentPlanSchema.parse({
    id: PLAN,
    tenantId: TENANT,
    workspaceId: WS,
    name: "P",
    strategy: { objective: "product_launch" },
    scope: {},
    knowledge: {},
    topology: {},
    graph: { nodes: nodes.map((n) => ({ role: "Piece", position: { x: 0, y: 0 }, ...n })), edges: [] },
    createdAt: T,
    updatedAt: T,
  });
  db.seed(PATH, PLAN, plan);
  db.seed("workspaces", WS, { tenantId: TENANT, name: "Acme" });
  return plan;
}

const hub = { id: "hub", type: "hub" as const, channel: "blog" };
const post = { id: "li", type: "spoke" as const, channel: "linkedin" };
const made = { purpose: "blog_write" as const, promptId: "content.blog_draft", repaired: true, sources: ["brand_map" as const, "knowledge" as const, "knowledge" as const] };
let clock = 0;
const deps = (db: FakeFirestore) => ({ db, now: () => new Date(Date.parse(T) + clock * 60_000) });

beforeEach(() => {
  clock = 0;
  vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("pinOriginal", () => {
  it("keeps nothing with the switch off, or for empty copy", async () => {
    vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "false");
    const db = new FakeFirestore();
    expect(await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, madeBy: made }, deps(db))).toBeNull();
    vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "true");
    expect(await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: "  ", madeBy: made }, deps(db))).toBeNull();
    expect(db.raw(ORIGINALS, aiOriginalId(PLAN, "hub"))).toBeUndefined();
  });

  it("keeps the copy with its stamp, who wrote it and what the writer read", async () => {
    const db = new FakeFirestore();
    const doc = await pinOriginal(autopilot, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, meta: { metaTitle: "Tracking" }, madeBy: made }, deps(db));
    expect(doc).toMatchObject({ planId: PLAN, workspaceId: WS, nodeId: "hub", nodeType: "hub", channel: "blog", regenerations: 0, pairs: [] });
    expect(doc!.original).toMatchObject({ body: ARTICLE, metaTitle: "Tracking", by: "autopilot", userId: null, sources: ["brand_map", "knowledge"] });
    expect(doc!.original.stamp).toMatchObject({ purpose: "blog_write", promptId: "content.blog_draft", repaired: true });
    expect(doc!.original.stamp!.promptVersion).toBeGreaterThan(0);
    expect(doc!.original.stamp!.templateHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("counts a piece written again, and does nothing for the same copy", async () => {
    const db = new FakeFirestore();
    const args = { plan: { id: PLAN, workspaceId: WS }, node: post, madeBy: { ...made, purpose: "content_write" as const, promptId: "content.fill" } };
    await pinOriginal(person, { ...args, body: "First." }, deps(db));
    await pinOriginal(person, { ...args, body: "First." }, deps(db));
    const doc = await pinOriginal(person, { ...args, body: "Second." }, deps(db));
    expect(doc).toMatchObject({ regenerations: 1, original: { body: "Second.", by: "person", userId: "uid_1" } });
  });

  it("records an id the prompt registry doesn't know, with no version", () => {
    expect(stampOf({ purpose: "content_write", promptId: "no.such.prompt", sources: [] })).toMatchObject({ promptVersion: 0, templateHash: "" });
    expect(stampOf(undefined)).toBeNull();
  });
});

describe("followCheck", () => {
  it("moves the pin to the checked copy only while the pin is the copy checked", async () => {
    const db = new FakeFirestore();
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, madeBy: made }, deps(db));
    expect(await followCheck(person, { planId: PLAN, nodeId: "hub", before: "someone else's copy", after: "checked" }, deps(db))).toBe(false);
    expect(await followCheck(person, { planId: PLAN, nodeId: "hub", before: ARTICLE, after: `${ARTICLE} Checked.` }, deps(db))).toBe(true);
    expect((await readOriginal(person, PLAN, "hub", deps(db)))!.original.body).toBe(`${ARTICLE} Checked.`);
  });
});

describe("recordApproval", () => {
  it("keeps the approved copy beside the original, once, and at most 3", async () => {
    const db = new FakeFirestore();
    const plan = { id: PLAN, workspaceId: WS };
    await pinOriginal(person, { plan, node: post, body: "Draft one.", madeBy: made }, deps(db));
    clock = 30;
    const pair = await recordApproval(person, { planId: PLAN, node: { ...post, body: "Draft one, edited." }, trigger: "approve" }, deps(db));
    expect(pair).toMatchObject({ trigger: "approve", final: { body: "Draft one, edited.", userId: "uid_1" }, measures: { minutesToApprove: 30, approvedAsWritten: false } });
    // Found live with the same copy: the same approval, kept once.
    expect(await recordApproval(person, { planId: PLAN, node: { ...post, body: "Draft one, edited." }, trigger: "live" }, deps(db))).toBeNull();
    for (const n of [2, 3, 4]) {
      await pinOriginal(person, { plan, node: post, body: `Draft ${n}.`, madeBy: made }, deps(db));
      await recordApproval(person, { planId: PLAN, node: { ...post, body: `Draft ${n}.` }, trigger: "approve" }, deps(db));
    }
    const doc = (await readOriginal(person, PLAN, "li", deps(db)))!;
    expect(doc.pairs.map((p) => p.final.body)).toEqual(["Draft 4.", "Draft 3.", "Draft 2."]);
    expect(doc.pairs[0]!.measures.approvedAsWritten).toBe(true);
    // Regenerations count from one approval to the next.
    expect(doc.regenerations).toBe(0);
  });

  it("keeps nothing for a piece with no AI original", async () => {
    const db = new FakeFirestore();
    expect(await recordApproval(person, { planId: PLAN, node: { ...post, body: "Typed by hand." }, trigger: "approve" }, deps(db))).toBeNull();
  });

  it("finds the pieces a save approved", () => {
    const db = new FakeFirestore();
    const before = seedPlan(db, [
      { ...hub, body: ARTICLE, status: "generated" },
      { ...post, body: "Post.", status: "approved" },
    ]);
    const after = { ...before, graph: { ...before.graph, nodes: before.graph.nodes.map((n) => ({ ...n, status: "approved" as const })) } };
    expect(newlyApproved(before, after).map((n) => n.id)).toEqual(["hub"]);
  });

  it("keeps each approval a save made", async () => {
    const db = new FakeFirestore();
    const before = seedPlan(db, [{ ...hub, body: ARTICLE, status: "generated" }]);
    await pinOriginal(person, { plan: before, node: hub, body: ARTICLE, madeBy: made }, deps(db));
    const edited = ARTICLE.replace("## How\n\nA tool asks every day.", "## How\n\nA tool asks every day.\n\n## Cost\n\nFrom $50 a month.");
    const after = { ...before, graph: { ...before.graph, nodes: [{ ...before.graph.nodes[0]!, body: edited, status: "approved" as const }] } };
    expect(await recordApprovals(person, { before, after }, deps(db))).toBe(1);
    const doc = (await readOriginal(person, PLAN, "hub", deps(db)))!;
    expect(doc.pairs[0]!.measures).toMatchObject({ sectionsAdded: ["Cost"], sectionsCut: [], figuresAdded: ["$50"] });
  });
});

describe("approvals count kept or edited (learning loops step 5)", () => {
  const blogStamp: LoopStamp = { made: "m1.blog_write.0.n", kind: "blog_write", scope: "blog_write", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: T };
  const cell = (db: FakeFirestore, kind: string) =>
    (sumWeek(db, TENANT, loopWeekOf(new Date())) as { c?: Record<string, Record<string, unknown>> }).c?.[kind]?.[kind];
  const approve = (plan: ContentPlan, body: string, extra: Record<string, unknown> = {}) => ({
    ...plan,
    graph: { ...plan.graph, nodes: [{ ...plan.graph.nodes[0]!, ...extra, body, status: "approved" as const }] },
  });

  it("counts an article's first approval of its AI original by the words changed, once", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    const before = seedPlan(db, [{ ...hub, body: ARTICLE, status: "generated" }]);
    await pinOriginal(person, { plan: before, node: hub, body: ARTICLE, madeBy: made }, deps(db));
    const edited = ARTICLE.replace("Buyers ask AI first.", "Most buyers ask AI first.");
    expect(await recordApprovals(person, { before, after: approve(before, edited, { made: blogStamp }) }, deps(db))).toBe(1);
    expect(cell(db, "blog_write")).toEqual({ v0: { none: { edited: 1 } } });
    // Approved again with other words, the same AI original counts no more.
    clock = 5;
    expect(await recordApprovals(person, { before, after: approve(before, ARTICLE, { made: blogStamp }) }, deps(db))).toBe(1);
    expect(cell(db, "blog_write")).toEqual({ v0: { none: { edited: 1 } } });
    // Written again, its new AI original counts once more: approved as written is kept.
    clock = 10;
    await pinOriginal(person, { plan: before, node: hub, body: `${ARTICLE}\n\nMore.`, madeBy: made }, deps(db));
    await recordApprovals(person, { before, after: approve(before, `${ARTICLE}\n\nMore.`, { made: blogStamp }) }, deps(db));
    expect(cell(db, "blog_write")).toEqual({ v0: { none: { edited: 1, kept: 1 } } });
  });

  it("leaves a LinkedIn or X post to its publish, and counts nothing with LOOPS_ENABLED off", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    const before = seedPlan(db, [{ ...post, body: "Post.", status: "generated" }]);
    await pinOriginal(person, { plan: before, node: post, body: "Post.", madeBy: made }, deps(db));
    await recordApprovals(person, { before, after: approve(before, "Post.", { made: { ...blogStamp, made: "m1.content_write.0.n", kind: "content_write", scope: "content_write" } }) }, deps(db));
    expect(db.dump("loop_days")).toEqual([]);

    vi.stubEnv("LOOPS_ENABLED", "");
    const db2 = new FakeFirestore();
    const plan2 = seedPlan(db2, [{ ...hub, body: ARTICLE, status: "generated" }]);
    await pinOriginal(person, { plan: plan2, node: hub, body: ARTICLE, madeBy: made }, deps(db2));
    await recordApprovals(person, { before: plan2, after: approve(plan2, ARTICLE, { made: blogStamp }) }, deps(db2));
    expect(db2.dump("loop_days")).toEqual([]);
  });
});

describe("the AI draft view", () => {
  it("shows the approval and the copy as it is now, section by section", async () => {
    const db = new FakeFirestore();
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, madeBy: made }, deps(db));
    const edited = ARTICLE.replace("Buyers ask AI first.", "Most buyers ask AI first.");
    await recordApproval(person, { planId: PLAN, node: { ...hub, body: edited }, trigger: "approve" }, deps(db));
    const doc = (await readOriginal(person, PLAN, "hub", deps(db)))!;
    const view = aiOriginalView(doc, { ...hub, body: edited }, T);
    expect(view.approval).toMatchObject({ trigger: "approve", measures: { sectionsChanged: 1 } });
    expect(view.sections.map((s) => [s.heading, s.state])).toEqual([
      ["", "same"],
      ["Why", "changed"],
      ["How", "same"],
    ]);
    expect(view.sections[1]!.segments.some((s) => s.op === "ins" && s.text.includes("Most"))).toBe(true);
  });
});

describe("tenants and deletion", () => {
  it("never lets another brand read a piece's AI original", async () => {
    const db = new FakeFirestore();
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, madeBy: made }, deps(db));
    expect(await readOriginal(other, PLAN, "hub", deps(db))).toBeNull();
    await expect(pinOriginal(other, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: "Theirs.", madeBy: made }, deps(db))).rejects.toThrow();
    expect((db.raw(ORIGINALS, aiOriginalId(PLAN, "hub")) as unknown as AiOriginalDoc).original.body).toBe(ARTICLE);
  });

  it("deletes a plan's AI originals with the plan", async () => {
    const db = new FakeFirestore();
    seedPlan(db, [hub, post]);
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, madeBy: made }, deps(db));
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: post, body: "Post.", madeBy: made }, deps(db));
    await deleteContentPlan(person, WS, PLAN, db);
    expect(db.raw(ORIGINALS, aiOriginalId(PLAN, "hub"))).toBeUndefined();
    expect(db.raw(ORIGINALS, aiOriginalId(PLAN, "li"))).toBeUndefined();
  });
});

describe("fillPlanNode", () => {
  const generate = vi.fn(async () => ({
    body: "A post Vizzy wrote.",
    placeholderValues: {},
    status: "generated" as const,
    warnings: [],
    format: "linkedin-post",
    madeBy: { purpose: "content_write" as const, promptId: "content.fill", sources: ["knowledge" as const] },
  })) as unknown as typeof generateNode;

  it("pins what the writer made, with its stamp", async () => {
    const db = new FakeFirestore();
    const plan = seedPlan(db, [post]);
    const r = await fillPlanNode(person, { workspace: { id: WS }, plan, nodeId: "li" }, { db, generate, preferences: vi.fn(async () => []) });
    expect(r.ok).toBe(true);
    expect(await readOriginal(person, PLAN, "li", { db })).toMatchObject({ original: { body: "A post Vizzy wrote.", by: "person", stamp: { promptId: "content.fill" }, sources: ["knowledge"] } });
  });

  it("pins nothing with the switch off", async () => {
    vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "false");
    const db = new FakeFirestore();
    const plan = seedPlan(db, [post]);
    await fillPlanNode(person, { workspace: { id: WS }, plan, nodeId: "li" }, { db, generate, preferences: vi.fn(async () => []) });
    expect(db.raw(ORIGINALS, aiOriginalId(PLAN, "li"))).toBeUndefined();
  });
});

describe("Vizzy's read of a plan", () => {
  it("adds how each piece changed from its AI draft, with what each number means", async () => {
    const db = new FakeFirestore();
    seedPlan(db, [{ ...post, body: "Draft one, edited.", status: "approved" }]);
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: post, body: "Draft one.", madeBy: made }, deps(db));
    await recordApproval(person, { planId: PLAN, node: { ...post, body: "Draft one, edited." }, trigger: "approve" }, deps(db));
    const r = await agentContentPlan(person, WS, PLAN, db);
    const body = r.body as { pieces: Array<{ edit: Record<string, unknown> | null }>; meanings: Record<string, unknown> };
    expect(body.pieces[0]!.edit).toMatchObject({ writtenBy: "person", approvedBy: "a person", approvedAsWritten: false, draftRegenerations: 0 });
    expect(Object.keys(body.meanings)).toEqual(expect.arrayContaining(["draftWordsChanged", "draftWordsChangedShare", "draftSectionsAdded", "draftMinutesToApprove"]));
  });

  it("names the approved pieces a draft followed as examples, and nothing when it followed none", async () => {
    const db = new FakeFirestore();
    const email = { id: "e1", type: "email" as const, channel: "newsletter" };
    seedPlan(db, [{ ...email, body: "Hi {{first_name}}" }, { ...post, body: "Post." }]);
    const examples = [{ workspaceId: WS, planId: "plan_0", nodeId: "e0" }];
    const emailMade = { purpose: "content_email" as const, promptId: "content.email_fill", sources: ["exemplars" as const], examples };
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: email, body: "Hi {{first_name}}", madeBy: emailMade }, deps(db));
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: post, body: "Post.", madeBy: made }, deps(db));
    expect(db.raw(ORIGINALS, aiOriginalId(PLAN, "e1"))?.original).toMatchObject({ sources: ["exemplars"], examples });
    expect(db.raw(ORIGINALS, aiOriginalId(PLAN, "li"))?.original).not.toHaveProperty("examples");
    const r = await agentContentPlan(person, WS, PLAN, db);
    const body = r.body as { pieces: Array<{ id: string; edit: Record<string, unknown> | null }> };
    expect(body.pieces.find((p) => p.id === "e1")!.edit).toMatchObject({ followedExamples: [{ workspaceId: WS, planId: "plan_0", pieceId: "e0" }] });
    expect(body.pieces.find((p) => p.id === "li")!.edit).not.toHaveProperty("followedExamples");
  });

  it("reads as before with the switch off", async () => {
    vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "false");
    const db = new FakeFirestore();
    seedPlan(db, [{ ...post, body: "Post." }]);
    const r = await agentContentPlan(person, WS, PLAN, db);
    const body = r.body as { pieces: Array<Record<string, unknown>>; meanings?: unknown };
    expect(body.pieces[0]).not.toHaveProperty("edit");
    expect(body).not.toHaveProperty("meanings");
  });
});
