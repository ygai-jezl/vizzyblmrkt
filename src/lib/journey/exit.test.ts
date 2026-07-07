import { describe, it, expect } from "vitest";
import type { JourneyGraph } from "@/lib/types/journey";
import { DEFAULT_BRANCH } from "./conditions";
import { appendConvergentExit } from "./exit";

/** trigger → email → wait (dangling tail). */
const linear = (): JourneyGraph => ({
  nodes: [
    { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "e0", type: "email", position: { x: 200, y: 0 }, data: { subject: "hi", body: "b" } },
    { id: "w0", type: "wait", position: { x: 400, y: 0 }, data: { waitHours: 24 } },
  ],
  edges: [
    { id: "et", source: "t", target: "e0", sourceHandle: null },
    { id: "ew", source: "e0", target: "w0", sourceHandle: null },
  ],
});

/** trigger → email → condition(b1 wired to e1, b2 + default dangling). */
const branched = (): JourneyGraph => ({
  nodes: [
    { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "e0", type: "email", position: { x: 200, y: 0 }, data: { subject: "hi", body: "b" } },
    {
      id: "c1",
      type: "condition",
      position: { x: 400, y: 0 },
      data: {
        branches: [
          { id: "b1", conditions: [{ field: "madeReferral", operator: "is_true" }] },
          { id: "b2", conditions: [{ field: "madeReferral", operator: "is_false" }] },
        ],
      },
    },
    { id: "e1", type: "email", position: { x: 600, y: 0 }, data: { subject: "yes", body: "b" } },
  ],
  edges: [
    { id: "et", source: "t", target: "e0", sourceHandle: null },
    { id: "ec", source: "e0", target: "c1", sourceHandle: null },
    { id: "eb1", source: "c1", target: "e1", sourceHandle: "b1" },
  ],
});

function exitNodes(g: JourneyGraph) {
  return g.nodes.filter((n) => n.type === "exit");
}
function edgesInto(g: JourneyGraph, targetId: string) {
  return g.edges.filter((e) => e.target === targetId);
}

describe("appendConvergentExit", () => {
  it("adds one exit and wires the dangling tail of a linear graph into it", () => {
    const out = appendConvergentExit(linear());
    const exits = exitNodes(out);
    expect(exits).toHaveLength(1);
    // The wait node was the only open end; e1/trigger already have outgoing edges.
    const into = edgesInto(out, exits[0]!.id);
    expect(into.map((e) => e.source).sort()).toEqual(["w0"]);
  });

  it("converges every leaf AND every condition branch/default into one exit", () => {
    const out = appendConvergentExit(branched());
    const exits = exitNodes(out);
    expect(exits).toHaveLength(1);
    const exitId = exits[0]!.id;

    // e1 (wired-branch leaf) + condition handles b2 and default should all reach exit.
    const into = edgesInto(out, exitId);
    expect(into.map((e) => e.source).sort()).toEqual(["c1", "c1", "e1"]);

    // b2 and the implicit default handle are the two condition edges to exit;
    // b1 already routed to e1, so it is NOT re-wired to exit.
    const condHandles = into
      .filter((e) => e.source === "c1")
      .map((e) => e.sourceHandle)
      .sort();
    expect(condHandles).toEqual([DEFAULT_BRANCH, "b2"].sort());
  });

  it("is idempotent — a second pass adds nothing", () => {
    const once = appendConvergentExit(branched());
    const twice = appendConvergentExit(once);
    expect(exitNodes(twice)).toHaveLength(1);
    expect(twice.nodes).toHaveLength(once.nodes.length);
    expect(twice.edges).toHaveLength(once.edges.length);
  });

  it("reuses an existing exit node instead of adding a second", () => {
    const g = branched();
    g.nodes.push({ id: "exit_pre", type: "exit", position: { x: 800, y: 0 }, data: {} });
    const out = appendConvergentExit(g);
    const exits = exitNodes(out);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.id).toBe("exit_pre");
    expect(edgesInto(out, "exit_pre").length).toBeGreaterThan(0);
  });

  it("de-dupes a branch literally named 'default' into a single, uniquely-id'd exit edge", () => {
    const g: JourneyGraph = {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        { id: "e0", type: "email", position: { x: 200, y: 0 }, data: { subject: "hi", body: "b" } },
        {
          id: "c1",
          type: "condition",
          position: { x: 400, y: 0 },
          data: {
            branches: [{ id: "default", conditions: [{ field: "madeReferral", operator: "is_true" }] }],
          },
        },
      ],
      edges: [
        { id: "et", source: "t", target: "e0", sourceHandle: null },
        { id: "ec", source: "e0", target: "c1", sourceHandle: null },
      ],
    };
    const out = appendConvergentExit(g);
    const exitId = exitNodes(out)[0]!.id;
    // The branch id "default" collides with the implicit DEFAULT_BRANCH handle —
    // exactly ONE edge should leave that handle, not two.
    const toExit = out.edges.filter((e) => e.target === exitId && e.source === "c1");
    expect(toExit).toHaveLength(1);
    expect(toExit[0]!.sourceHandle).toBe(DEFAULT_BRANCH);
    // All edge ids are unique.
    const ids = out.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves a graph that already terminates cleanly untouched", () => {
    const out = appendConvergentExit(linear());
    const again = appendConvergentExit(out);
    expect(again).toBe(out); // early-return returns the same reference
  });
});
