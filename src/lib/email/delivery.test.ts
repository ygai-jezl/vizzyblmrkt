import { describe, it, expect } from "vitest";
import { resolveNextStep } from "./delivery";
import type { JourneyGraph } from "@/lib/types/journey";

function graph(
  nodes: Array<[string, "trigger" | "email" | "wait" | "condition", number?]>,
  // [source, target] or [source, target, sourceHandle]
  edges: Array<[string, string] | [string, string, string]>,
): JourneyGraph {
  return {
    nodes: nodes.map(([id, type, waitHours]) => ({
      id,
      type,
      position: { x: 0, y: 0 },
      data: type === "wait" ? { waitHours: waitHours ?? 0 } : { subject: id },
    })),
    edges: edges.map(([source, target, sourceHandle], i) => ({
      id: `e${i}`,
      source,
      target,
      sourceHandle: sourceHandle ?? null,
    })),
  };
}

describe("resolveNextStep (journey traversal)", () => {
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
    expect(resolveNextStep(g, "trigger")).toEqual({
      nodeId: "email1",
      delayHours: 0,
      type: "email",
    });
  });

  it("sums wait nodes into the delay to the next email", () => {
    expect(resolveNextStep(g, "email1")).toEqual({
      nodeId: "email2",
      delayHours: 24,
      type: "email",
    });
  });

  it("returns null at a dead end", () => {
    expect(resolveNextStep(g, "email2")).toBeNull();
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
    expect(resolveNextStep(loop, "a")).toEqual({
      nodeId: "b",
      delayHours: 0,
      type: "email",
    });
    expect(resolveNextStep(loop, "b")).toEqual({
      nodeId: "a",
      delayHours: 0,
      type: "email",
    });
  });

  it("stops at a condition node, summing the wait before it", () => {
    // email1 → wait(24) → cond
    const g2 = graph(
      [
        ["email1", "email"],
        ["wait1", "wait", 24],
        ["cond", "condition"],
      ],
      [
        ["email1", "wait1"],
        ["wait1", "cond"],
      ],
    );
    expect(resolveNextStep(g2, "email1")).toEqual({
      nodeId: "cond",
      delayHours: 24,
      type: "condition",
    });
  });

  it("follows the chosen branch handle out of a condition node", () => {
    // cond -(yes)-> wait(12) -> emailA ; cond -(default)-> emailB
    const g3 = graph(
      [
        ["cond", "condition"],
        ["wait1", "wait", 12],
        ["emailA", "email"],
        ["emailB", "email"],
      ],
      [
        ["cond", "wait1", "yes"],
        ["wait1", "emailA"],
        ["cond", "emailB", "default"],
      ],
    );
    expect(resolveNextStep(g3, "cond", "yes")).toEqual({
      nodeId: "emailA",
      delayHours: 12,
      type: "email",
    });
    expect(resolveNextStep(g3, "cond", "default")).toEqual({
      nodeId: "emailB",
      delayHours: 0,
      type: "email",
    });
  });

  it("returns null when the requested branch is unconnected", () => {
    const g4 = graph(
      [
        ["cond", "condition"],
        ["emailA", "email"],
      ],
      [["cond", "emailA", "yes"]],
    );
    // The "default" branch was never wired → dead end.
    expect(resolveNextStep(g4, "cond", "default")).toBeNull();
  });
});
