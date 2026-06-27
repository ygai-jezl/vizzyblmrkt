import { describe, it, expect } from "vitest";
import type { JourneyGraph } from "@/lib/types/journey";
import { fixJourneyGraph, type FixOptions } from "./graphFix";

// A broken condition graph in the shape the incident produced: a branch with an
// invalid field key (cast — real bad prod data), branch edge wired, NO default.
const broken = (): JourneyGraph =>
  ({
    nodes: [
      { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      { id: "e0", type: "email", position: { x: 0, y: 0 }, data: { subject: "hi", body: "b" } },
      {
        id: "c1",
        type: "condition",
        position: { x: 0, y: 0 },
        data: {
          branches: [
            { id: "b1", label: "voice, no ref", condition: { field: "voice_chat", operator: "eq", value: true } },
          ],
        },
      },
      { id: "e1", type: "email", position: { x: 0, y: 0 }, data: { subject: "next", body: "b" } },
      { id: "ed", type: "email", position: { x: 0, y: 0 }, data: { subject: "none", body: "b" } },
    ],
    edges: [
      { id: "et", source: "t", target: "e0", sourceHandle: null },
      { id: "ec", source: "e0", target: "c1", sourceHandle: null },
      { id: "eb1", source: "c1", target: "e1", sourceHandle: "b1" },
    ],
  }) as unknown as JourneyGraph;

const opts: FixOptions = {
  branchRules: {
    b1: {
      match: "all",
      conditions: [
        { field: "usedVoiceChat", operator: "is_true" },
        { field: "referralCount", operator: "eq", value: 0 },
      ],
    },
  },
  defaultTargets: { c1: "ed" },
};

describe("fixJourneyGraph", () => {
  it("rewrites a broken branch to its multi-factor rule set and clears the legacy rule", () => {
    const { graph, changes } = fixJourneyGraph(broken(), opts);
    const c1 = graph.nodes.find((n) => n.id === "c1")!;
    const b1 = c1.data.branches![0]!;
    expect(b1.condition).toBeUndefined();
    expect(b1.match).toBe("all");
    expect(b1.conditions).toEqual([
      { field: "usedVoiceChat", operator: "is_true" },
      { field: "referralCount", operator: "eq", value: 0 },
    ]);
    expect(b1.label).toBe("voice, no ref"); // label preserved
    expect(changes.some((c) => c.kind === "branch_rewritten")).toBe(true);
  });

  it("wires a default else-edge to the provided target", () => {
    const { graph, changes } = fixJourneyGraph(broken(), opts);
    const def = graph.edges.find((e) => e.source === "c1" && e.sourceHandle === "default");
    expect(def).toMatchObject({ target: "ed", id: "edge_default_c1" });
    expect(changes.some((c) => c.kind === "default_edge_added")).toBe(true);
  });

  it("does not mutate the input graph", () => {
    const input = broken();
    const before = JSON.stringify(input);
    fixJourneyGraph(input, opts);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("is idempotent — fix(fix(g)) produces no further changes", () => {
    const once = fixJourneyGraph(broken(), opts);
    const twice = fixJourneyGraph(once.graph, opts);
    expect(twice.changes).toEqual([]);
    expect(twice.graph).toEqual(once.graph); // no duplicate default edge, no churn
  });

  it("warns (does not silently touch) a branch with an unknown field and no rule", () => {
    const g = broken();
    // add a second branch with a bad field but provide NO rule for it
    g.nodes.find((n) => n.id === "c1")!.data.branches!.push({
      id: "b2",
      condition: { field: "referrals", operator: "eq", value: 1 },
    } as never);
    const { changes } = fixJourneyGraph(g, opts);
    const warn = changes.find((c) => c.kind === "warning" && c.branchId === "b2");
    expect(warn).toBeTruthy();
  });
});
