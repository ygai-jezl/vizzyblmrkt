import { describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { createContentPlan, getContentPlan } from "@/lib/tenant/workspaceContent";
import { keepApprovedSeen } from "@/lib/content/blog/hubActions";
import { autopilotHolds } from "./planLock";
import { createRun, getRun } from "./runs";
import { takeOver } from "./takeOver";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" };

const planInput = (over: Record<string, unknown> = {}) =>
  ({
    name: "How do I get cited?",
    status: "draft",
    strategy: { objective: "brand_visibility" },
    scope: { topics: [], spark: "" },
    knowledge: {},
    topology: { hubChannel: "blog", spokeChannels: [] },
    graph: { nodes: [{ id: "hub", type: "hub", role: "hub", channel: "blog", status: "generated", body: "x", position: { x: 0, y: 0 } }], edges: [] },
    ...over,
  }) as never;

describe("the autopilot's lock on a plan", () => {
  it("holds only while the run is working", () => {
    expect(autopilotHolds({ autopilot: { runId: "run_x", state: "working", at: "" } })).toBe(true);
    expect(autopilotHolds({ autopilot: { runId: "run_x", state: "done", at: "" } })).toBe(false);
    expect(autopilotHolds({ autopilot: null })).toBe(false);
    expect(autopilotHolds(null)).toBe(false);
  });

  it("creates a plan with a fixed id once, so a retried step finds the first", async () => {
    const db = new FakeFirestore();
    const first = await createContentPlan(A, "ws1", planInput(), db, { id: "plan_fixed1" });
    const again = await createContentPlan(A, "ws1", planInput({ name: "Other" }), db, { id: "plan_fixed1" });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("How do I get cited?");
  });

  it("lets a person take over: the run stops and the lock lifts, and again is a no-op", async () => {
    const db = new FakeFirestore();
    const run = await createRun(A, { id: "run_aaaaaaaaaaaaaaaaaaaaaaaa", mode: "draft", trigger: "schedule", step: "write", question: null }, { db });
    await createContentPlan(A, "ws1", planInput({ autopilot: { runId: run.id, state: "working", at: "2026-11-18T12:00:00.000Z" } }), db, { id: "plan_fixed2" });
    expect(await takeOver(A, "ws1", "plan_fixed2", { db })).toEqual({ status: 200, body: { ok: true } });
    expect((await getContentPlan(A, "ws1", "plan_fixed2", db))!.autopilot!.state).toBe("stopped");
    expect(await getRun(A, run.id, { db })).toMatchObject({ step: "stopped", active: false, error: "taken_over" });
    expect(await takeOver(A, "ws1", "plan_fixed2", { db })).toEqual({ status: 200, body: { ok: true, already: true } });
    expect(await takeOver({ ...A, tenantId: "ten_B" }, "ws1", "plan_fixed2", { db })).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("an autopilot draft's notes", () => {
  it("are kept only when a person approves its hub", async () => {
    vi.stubEnv("BRAND_NOTES_ENABLED", "true");
    const db = new FakeFirestore();
    const brief = { primaryQuestion: "How do I get cited?", seen: { notes: [], near: [], removed: [], own: "", save: false, asks: [], matchedFor: "", matchedAt: "" } };
    const before = (await createContentPlan(A, "ws1", planInput({ blog: brief, autopilot: { runId: "run_x", state: "done", at: "" } }), db, { id: "plan_fixed3" })) as never as Parameters<typeof keepApprovedSeen>[1]["before"];
    const approved = { ...before, graph: { ...before.graph, nodes: before.graph.nodes.map((n) => ({ ...n, status: "approved" as const })) } };
    expect(await keepApprovedSeen(A, { workspaceId: "ws1", before, after: before }, { db })).toBe(false);
    expect(await keepApprovedSeen(A, { workspaceId: "ws1", before, after: approved }, { db })).toBe(true);
    expect(await keepApprovedSeen(A, { workspaceId: "ws1", before: approved, after: approved }, { db })).toBe(false);
    expect(await keepApprovedSeen(A, { workspaceId: "ws1", before, after: { ...approved, autopilot: null } }, { db })).toBe(false);
    vi.unstubAllEnvs();
  });
});
