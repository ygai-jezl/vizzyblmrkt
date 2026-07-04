import { describe, it, expect, vi } from "vitest";

// Gemini off → architectSequence falls back to seeded briefs; the STRUCTURE is
// deterministic in code, so we can assert the graph shape without a live model.
vi.mock("@/lib/agents/gemini", () => ({
  generateText: vi.fn().mockResolvedValue(""),
  parseFirstJson: () => null,
}));

import { architectSequence } from "./architect";
import { _validateBlueprints } from "./sequenceBlueprints";

describe("architectSequence", () => {
  it("builds a linear welcome drip; structural nodes pre-generated, emails empty", async () => {
    const g = await architectSequence({
      sequenceType: "welcome",
      spark: "founders who write",
      topicLabels: [],
      knowledgeContext: "",
    });
    const emails = g.nodes.filter((n) => n.type === "email");
    expect(g.nodes.filter((n) => n.type === "trigger")).toHaveLength(1);
    expect(emails.length).toBeGreaterThanOrEqual(3);
    for (const n of g.nodes) {
      if (n.type === "trigger" || n.type === "wait" || n.type === "condition") {
        expect(n.status).toBe("generated"); // nothing to fill → plan can reach "ready"
      }
      if (n.type === "email") {
        expect(n.status).toBe("empty");
        expect(n.channel).toBe("newsletter");
        expect(n.framework).toBeTruthy();
      }
    }
    // Every non-trigger node has an incoming edge (the chain is connected).
    const targets = new Set(g.edges.map((e) => e.target));
    for (const n of g.nodes) if (n.type !== "trigger") expect(targets.has(n.id)).toBe(true);
  });

  it("emits a labeled Yes/No split for win_back", async () => {
    const g = await architectSequence({
      sequenceType: "win_back",
      spark: "",
      topicLabels: [],
      knowledgeContext: "",
    });
    const cond = g.nodes.find((n) => n.type === "condition");
    expect(cond).toBeTruthy();
    const outgoing = g.edges.filter((e) => e.source === cond!.id);
    expect(outgoing).toHaveLength(2);
    const labels = outgoing.map((e) => e.label);
    expect(labels).toContain("Re-engaged");
    expect(labels).toContain("Still quiet");
  });

  it("all sequence blueprints are structurally valid", () => {
    expect(_validateBlueprints()).toEqual([]);
  });
});
