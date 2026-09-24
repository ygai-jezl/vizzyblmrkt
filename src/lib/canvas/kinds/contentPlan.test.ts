import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => null) };
});

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import type { ContentGraph, ContentNode } from "@/lib/types/contentPlan";
import { authorContentPlanDraft, type ContentPlanDeps } from "./contentPlan";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u1", role: "admin" };
const node = (id: string, type: ContentNode["type"], x: number): ContentNode =>
  ({ id, type, channel: type === "hub" ? "newsletter" : "linkedin", role: id, position: { x, y: 0 }, body: "", placeholderValues: {}, status: "empty", warnings: [] }) as unknown as ContentNode;
const GRAPH: ContentGraph = {
  nodes: [node("hub", "hub", 0), node("spoke_1", "spoke", 200), node("spoke_2", "spoke", 400)],
  edges: [
    { id: "e1", source: "hub", target: "spoke_1" },
    { id: "e2", source: "hub", target: "spoke_2" },
  ],
} as ContentGraph;

const architect = vi.fn(async () => ({ ok: true as const, graph: GRAPH }));
const generate = vi.fn(async (input: { node: ContentNode }) => ({
  body: `Copy for ${input.node.id}`,
  placeholderValues: {},
  status: "generated" as const,
  warnings: [],
  format: "post",
}));
const deps = (db: FakeFirestore): ContentPlanDeps => ({ db, architect, generate: generate as never, budgetMs: 10_000 });

const intake = {
  name: "Five 15-minute dinners",
  strategy: { objective: "newsletter_signups" },
  scope: { topics: ["audience"], spark: "quick dinners" },
  knowledge: {},
  topology: { hubChannel: "newsletter", spokeChannels: ["linkedin"] },
};

function world() {
  const db = new FakeFirestore();
  db.seed("workspaces", "ws1", { tenantId: "ten_A", name: "The Weekly Plate", createdAt: "2026-09-01T00:00:00.000Z" });
  db.seed("workspaces", "ws_other", { tenantId: "ten_B", name: "Not yours", createdAt: "2026-09-01T00:00:00.000Z" });
  return db;
}
const plans = (db: FakeFirestore) => db.dump("workspaces/ws1/content_plans");

beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("CONTENT_CHAT_AUTHORING_ENABLED", "true");
  architect.mockClear();
  generate.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("content_plan canvas kind", () => {
  it("is unavailable while switched off, and can't see another tenant's programme", async () => {
    vi.stubEnv("CONTENT_CHAT_AUTHORING_ENABLED", "false");
    expect(await authorContentPlanDraft({ ctx, input: { scope: { workspaceId: "ws1" }, intake }, brief: "" }, deps(world()))).toMatchObject({ status: 503 });
    vi.stubEnv("CONTENT_CHAT_AUTHORING_ENABLED", "true");
    expect(await authorContentPlanDraft({ ctx, input: { scope: { workspaceId: "ws_other" }, intake }, brief: "" }, deps(world()))).toMatchObject({ status: 404 });
  });

  it("drafts a plan like the wizard does and writes only the hub, never approving anything", async () => {
    const db = world();
    const r = await authorContentPlanDraft({ ctx, input: { scope: { workspaceId: "ws1" }, intake }, brief: "Warm and practical" }, deps(db));
    expect(r).toMatchObject({ ok: true, card: { kind: "content_plan", stats: [{ value: 3 }, { value: 1 }, { value: 2 }] } });
    if (!r.ok) throw new Error("expected a draft");
    expect(r.url).toBe(`/admin/workspace/ws1/create/${r.id}`);
    const [plan] = plans(db);
    expect(plan).toMatchObject({ authoredBy: "agent", agentRevision: 1, agentBrief: "Warm and practical", status: "generating" });
    const nodes = (plan!.graph as ContentGraph).nodes;
    expect(nodes.find((n) => n.id === "hub")).toMatchObject({ status: "generated", body: "Copy for hub" });
    expect(nodes.filter((n) => n.type === "spoke").every((n) => n.status === "empty")).toBe(true);
    expect(nodes.some((n) => n.status === "approved")).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("refuses eBooks (they're written in the studio) and bad intakes", async () => {
    const db = world();
    const ebook = { ...intake, topology: { hubChannel: "ebook", spokeChannels: [] } };
    expect(await authorContentPlanDraft({ ctx, input: { scope: { workspaceId: "ws1" }, intake: ebook }, brief: "" }, deps(db))).toMatchObject({ status: 422, error: "ebook_in_studio" });
    expect(await authorContentPlanDraft({ ctx, input: { scope: { workspaceId: "ws1" }, intake: { name: "" } }, brief: "" }, deps(db))).toMatchObject({ status: 422, error: "invalid_intake" });
  });

  it("refill leaves approved work alone and waits for the hub before spokes", async () => {
    const db = world();
    const r = await authorContentPlanDraft({ ctx, input: { scope: { workspaceId: "ws1" }, intake }, brief: "" }, deps(db));
    if (!r.ok) throw new Error("expected a draft");
    const refill = (nodeIds: string[], instructions?: string) =>
      authorContentPlanDraft({ ctx, input: { scope: { workspaceId: "ws1", planId: r.id }, mode: "refill", nodeIds, instructions }, brief: "" }, deps(db));

    expect(await refill(["spoke_1"])).toMatchObject({ ok: false, status: 409, issues: ["spoke_1: approve the hub first"] });
    // A person approves the hub; now spokes can be written, and the canvas remounts on the new revision.
    const key = `workspaces/ws1/content_plans`;
    const plan = db.raw(key, r.id)!;
    const graph = plan.graph as ContentGraph;
    db.seed(key, r.id, { ...plan, graph: { ...graph, nodes: graph.nodes.map((n) => (n.id === "hub" ? { ...n, status: "approved" } : n)) } });
    __resetRateLimitState();
    const ok = await refill(["spoke_1"], "Lead with the time saved");
    expect(ok).toMatchObject({ ok: true });
    const after = db.raw(key, r.id)!;
    expect(after.agentRevision).toBe(2);
    const spoke = (after.graph as ContentGraph).nodes.find((n) => n.id === "spoke_1")!;
    expect(spoke).toMatchObject({ status: "generated" });
    expect(spoke.brief).toContain("Change: Lead with the time saved");
    __resetRateLimitState();
    db.cols.get("rate_limits")?.clear(); // the durable counter lives in Firestore too
    expect(await refill(["hub"])).toMatchObject({ ok: false, status: 409, issues: ["hub: approved by a person — leave it alone"] });
  });

  it("leaves no empty plan behind when the architect fails", async () => {
    const db = world();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const r = await authorContentPlanDraft(
      { ctx, input: { scope: { workspaceId: "ws1" }, intake }, brief: "" },
      { ...deps(db), architect: failing as never },
    );
    quiet.mockRestore();
    expect(r).toMatchObject({ ok: false, status: 502, error: "architect_failed" });
    expect(plans(db)).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("is rate-limited per tenant", async () => {
    const db = world();
    const go = () => authorContentPlanDraft({ ctx, input: { scope: { workspaceId: "ws1" }, intake }, brief: "" }, deps(db));
    for (let i = 0; i < 3; i += 1) expect(await go()).toMatchObject({ ok: true });
    expect(await go()).toMatchObject({ ok: false, status: 429 });
  });
});
