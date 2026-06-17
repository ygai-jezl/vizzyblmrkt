import { describe, it, expect } from "vitest";
import { resolveNextEmail } from "./delivery";
import type { JourneyGraph } from "@/lib/types/journey";

function graph(
  nodes: Array<[string, "trigger" | "email" | "wait", number?]>,
  edges: Array<[string, string]>,
): JourneyGraph {
  return {
    nodes: nodes.map(([id, type, waitHours]) => ({
      id,
      type,
      position: { x: 0, y: 0 },
      data: type === "wait" ? { waitHours: waitHours ?? 0 } : { subject: id },
    })),
    edges: edges.map(([source, target], i) => ({
      id: `e${i}`,
      source,
      target,
    })),
  };
}

describe("resolveNextEmail (journey traversal)", () => {
  // trigger → email1 → wait(24) → email2
  const g = graph(
    [
      ["trigger", "trigger"],
      ["email1", "email"],
      ["wait1", "wait", 24],
      ["email2", "email"],
    ],
    [
      ["trigger", "email1"],
      ["email1", "wait1"],
      ["wait1", "email2"],
    ],
  );

  it("finds the first email after the trigger with zero delay", () => {
    expect(resolveNextEmail(g, "trigger")).toEqual({
      nodeId: "email1",
      delayHours: 0,
    });
  });

  it("sums wait nodes into the delay to the next email", () => {
    expect(resolveNextEmail(g, "email1")).toEqual({
      nodeId: "email2",
      delayHours: 24,
    });
  });

  it("returns null at a dead end", () => {
    expect(resolveNextEmail(g, "email2")).toBeNull();
  });

  it("guards against cycles", () => {
    const loop = graph(
      [
        ["a", "email"],
        ["b", "email"],
      ],
      [
        ["a", "b"],
        ["b", "a"],
      ],
    );
    // a → b is a real next; b → a → b … must not loop forever.
    expect(resolveNextEmail(loop, "a")).toEqual({ nodeId: "b", delayHours: 0 });
    expect(resolveNextEmail(loop, "b")).toEqual({ nodeId: "a", delayHours: 0 });
  });
});
