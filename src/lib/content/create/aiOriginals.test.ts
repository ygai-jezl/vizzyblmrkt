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
    expect(await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, made }, deps(db))).toBeNull();
    vi.stubEnv("CONTENT_AI_ORIGINALS_ENABLED", "true");
    expect(await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: "  ", made }, deps(db))).toBeNull();
    expect(db.raw(ORIGINALS, aiOriginalId(PLAN, "hub"))).toBeUndefined();
  });

  it("keeps the copy with its stamp, who wrote it and what the writer read", async () => {
    const db = new FakeFirestore();
    const doc = await pinOriginal(autopilot, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, meta: { metaTitle: "Tracking" }, made }, deps(db));
    expect(doc).toMatchObject({ planId: PLAN, workspaceId: WS, nodeId: "hub", nodeType: "hub", channel: "blog", regenerations: 0, pairs: [] });
    expect(doc!.original).toMatchObject({ body: ARTICLE, metaTitle: "Tracking", by: "autopilot", userId: null, sources: ["brand_map", "knowledge"] });
    expect(doc!.original.stamp).toMatchObject({ purpose: "blog_write", promptId: "content.blog_draft", repaired: true });
    expect(doc!.original.stamp!.promptVersion).toBeGreaterThan(0);
    expect(doc!.original.stamp!.templateHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("counts a piece written again, and does nothing for the same copy", async () => {
    const db = new FakeFirestore();
    const args = { plan: { id: PLAN, workspaceId: WS }, node: post, made: { ...made, purpose: "content_write" as const, promptId: "content.fill" } };
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
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, made }, deps(db));
    expect(await followCheck(person, { planId: PLAN, nodeId: "hub", before: "someone else's copy", after: "checked" }, deps(db))).toBe(false);
    expect(await followCheck(person, { planId: PLAN, nodeId: "hub", before: ARTICLE, after: `${ARTICLE} Checked.` }, deps(db))).toBe(true);
    expect((await readOriginal(person, PLAN, "hub", deps(db)))!.original.body).toBe(`${ARTICLE} Checked.`);
  });
});

describe("recordApproval", () => {
  it("keeps the approved copy beside the original, once, and at most 3", async () => {
    const db = new FakeFirestore();
    const plan = { id: PLAN, workspaceId: WS };
    await pinOriginal(person, { plan, node: post, body: "Draft one.", made }, deps(db));
    clock = 30;
    const pair = await recordApproval(person, { planId: PLAN, node: { ...post, body: "Draft one, edited." }, trigger: "approve" }, deps(db));
    expect(pair).toMatchObject({ trigger: "approve", final: { body: "Draft one, edited.", userId: "uid_1" }, measures: { minutesToApprove: 30, approvedAsWritten: false } });
    // Found live with the same copy: the same approval, kept once.
    expect(await recordApproval(person, { planId: PLAN, node: { ...post, body: "Draft one, edited." }, trigger: "live" }, deps(db))).toBeNull();
    for (const n of [2, 3, 4]) {
      await pinOriginal(person, { plan, node: post, body: `Draft ${n}.`, made }, deps(db));
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
    await pinOriginal(person, { plan: before, node: hub, body: ARTICLE, made }, deps(db));
    const edited = ARTICLE.replace("## How\n\nA tool asks every day.", "## How\n\nA tool asks every day.\n\n## Cost\n\nFrom $50 a month.");
    const after = { ...before, graph: { ...before.graph, nodes: [{ ...before.graph.nodes[0]!, body: edited, status: "approved" as const }] } };
    expect(await recordApprovals(person, { before, after }, deps(db))).toBe(1);
    const doc = (await readOriginal(person, PLAN, "hub", deps(db)))!;
    expect(doc.pairs[0]!.measures).toMatchObject({ sectionsAdded: ["Cost"], sectionsCut: [], figuresAdded: ["$50"] });
  });
});

describe("the AI draft view", () => {
  it("shows the approval and the copy as it is now, section by section", async () => {
    const db = new FakeFirestore();
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, made }, deps(db));
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
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, made }, deps(db));
    expect(await readOriginal(other, PLAN, "hub", deps(db))).toBeNull();
    await expect(pinOriginal(other, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: "Theirs.", made }, deps(db))).rejects.toThrow();
    expect((db.raw(ORIGINALS, aiOriginalId(PLAN, "hub")) as unknown as AiOriginalDoc).original.body).toBe(ARTICLE);
  });

  it("deletes a plan's AI originals with the plan", async () => {
    const db = new FakeFirestore();
    seedPlan(db, [hub, post]);
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: hub, body: ARTICLE, made }, deps(db));
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: post, body: "Post.", made }, deps(db));
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
    made: { purpose: "content_write" as const, promptId: "content.fill", sources: ["knowledge" as const] },
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
    await pinOriginal(person, { plan: { id: PLAN, workspaceId: WS }, node: post, body: "Draft one.", made }, deps(db));
    await recordApproval(person, { planId: PLAN, node: { ...post, body: "Draft one, edited." }, trigger: "approve" }, deps(db));
    const r = await agentContentPlan(person, WS, PLAN, db);
    const body = r.body as { pieces: Array<{ edit: Record<string, unknown> | null }>; meanings: Record<string, unknown> };
    expect(body.pieces[0]!.edit).toMatchObject({ writtenBy: "person", approvedBy: "a person", approvedAsWritten: false, draftRegenerations: 0 });
    expect(Object.keys(body.meanings)).toEqual(expect.arrayContaining(["draftWordsChanged", "draftWordsChangedShare", "draftSectionsAdded", "draftMinutesToApprove"]));
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
