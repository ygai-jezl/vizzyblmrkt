import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/agents/gemini", () => ({
  generateText: vi.fn(),
  parseFirstJson: (text: string): unknown | null => {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s < 0 || e <= s) return null;
    try {
      return JSON.parse(text.slice(s, e + 1));
    } catch {
      return null;
    }
  },
}));

// The real meter, watched: the test can see which purpose the brief was counted under.
vi.mock("@/lib/plans/meter", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/plans/meter")>();
  return { ...real, aiUsage: vi.fn(real.aiUsage) };
});

import {
  gatherAncestorContext,
  generateNodeBrief,
  type GenerateNodeBriefInput,
} from "./nodeBrief";
import { generateText } from "@/lib/agents/gemini";
import { aiUsage } from "@/lib/plans/meter";
import type { ContentGraph, ContentNode, ContentPlan } from "@/lib/types/contentPlan";

const mocked = vi.mocked(generateText);
const noRag = vi.fn().mockResolvedValue(null);
const ctx = { tenantId: "ten_x", region: "us" } as unknown as GenerateNodeBriefInput["ctx"];

function node(partial: Partial<ContentNode>): ContentNode {
  return {
    id: partial.id ?? "n1",
    type: partial.type ?? "spoke",
    channel: partial.channel ?? "linkedin",
    format: null,
    blockType: partial.blockType ?? "hook",
    role: partial.role ?? "Spoke",
    position: { x: 0, y: 0 },
    templateId: partial.templateId ?? null,
    framework: partial.framework ?? null,
    brief: partial.brief ?? null,
    body: partial.body ?? "",
    placeholderValues: {},
    status: partial.status ?? "empty",
    scheduledAt: null,
    warnings: [],
    subject: null,
    previewText: null,
    subjectVariants: [],
    waitConfig: null,
    conditionConfig: null,
    layout: null,
  };
}

function edge(source: string, target: string): ContentGraph["edges"][number] {
  return { id: `e_${source}_${target}`, source, target, label: null };
}

function plan(graph: ContentGraph): ContentPlan {
  return {
    id: "p1",
    tenantId: "ten_x",
    workspaceId: "ws1",
    name: "Plan",
    status: "generating",
    strategy: { objective: "newsletter_signups", hubUrl: null, subscriberCount: null, sequenceType: null },
    scope: { topics: [], spark: "weekly writing", industryLens: "" },
    knowledge: { groundingScope: "global", proofAssets: [] },
    topology: { hubChannel: "newsletter", spokeChannels: ["linkedin"] },
    graph,
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("gatherAncestorContext", () => {
  it("walks a linear hub → spoke chain, root-first", () => {
    const hub = node({ id: "hub", type: "hub", channel: "newsletter", body: "hub body" });
    const spoke = node({ id: "s1", type: "spoke" });
    const graph: ContentGraph = { nodes: [hub, spoke], edges: [edge("hub", "s1")] };
    const anc = gatherAncestorContext(graph, "s1");
    expect(anc.map((a) => a.id)).toEqual(["hub"]);
    expect(anc[0]?.body).toBe("hub body");
  });

  it("unions multiple parents and orders the farthest (hub) first, nearest parent last", () => {
    // hub → mid → leaf, and hub → leaf directly (leaf has two parents at different depths).
    const hub = node({ id: "hub", type: "hub", channel: "newsletter" });
    const mid = node({ id: "mid", type: "spoke", role: "Mid" });
    const leaf = node({ id: "leaf", type: "spoke", role: "Leaf" });
    const graph: ContentGraph = {
      nodes: [hub, mid, leaf],
      edges: [edge("hub", "mid"), edge("mid", "leaf"), edge("hub", "leaf")],
    };
    const anc = gatherAncestorContext(graph, "leaf");
    // hub reached at distance 1 (direct) is deduped to its shortest hop; mid at distance 1.
    // Both are direct parents here, so order is stable by insertion (hub found first).
    expect(anc.map((a) => a.id).sort()).toEqual(["hub", "mid"]);
  });

  it("is cycle-safe (a → b → a) and never revisits", () => {
    const a = node({ id: "a", type: "spoke" });
    const b = node({ id: "b", type: "spoke" });
    const graph: ContentGraph = { nodes: [a, b], edges: [edge("a", "b"), edge("b", "a")] };
    const anc = gatherAncestorContext(graph, "b");
    expect(anc.map((a) => a.id)).toEqual(["a"]);
  });

  it("returns nothing for an unconnected node", () => {
    const solo = node({ id: "solo", type: "spoke" });
    expect(gatherAncestorContext({ nodes: [solo], edges: [] }, "solo")).toEqual([]);
  });
});

describe("generateNodeBrief", () => {
  beforeEach(() => {
    mocked.mockReset();
    noRag.mockClear();
  });

  it("returns the model's brief and feeds it the hub's body + the node's angle", async () => {
    mocked.mockResolvedValue(JSON.stringify({ brief: "Turn the hub's 3 tips into a LinkedIn list." }));
    const hub = node({ id: "hub", type: "hub", channel: "newsletter", body: "3 tips on writing" });
    const spoke = node({ id: "s1", type: "spoke", channel: "linkedin", framework: "listicle" });
    const graph: ContentGraph = { nodes: [hub, spoke], edges: [edge("hub", "s1")] };
    const { brief } = await generateNodeBrief(
      { ctx, workspaceId: "ws1", plan: plan(graph), node: spoke },
      noRag,
    );
    expect(brief).toBe("Turn the hub's 3 tips into a LinkedIn list.");
    const prompt = mocked.mock.calls.at(-1)?.[0] ?? "";
    expect(prompt).toContain("3 tips on writing"); // hub body is upstream context
    expect(prompt).toContain("Listicle"); // angle guidance injected
  });

  it("counts a brief as writing briefs, not as the piece it is for", async () => {
    vi.mocked(aiUsage).mockClear();
    mocked.mockResolvedValue(JSON.stringify({ brief: "One tip per line." }));
    const hub = node({ id: "hub", type: "hub", channel: "newsletter", body: "3 tips on baking bread" });
    const spoke = node({ id: "s1", type: "spoke", channel: "linkedin" });
    const graph: ContentGraph = { nodes: [hub, spoke], edges: [edge("hub", "s1")] };
    await generateNodeBrief({ ctx, workspaceId: "ws1", plan: plan(graph), node: spoke }, noRag);
    expect(vi.mocked(aiUsage).mock.calls.map((c) => c[1])).toEqual(["content_brief"]);
    expect(mocked.mock.calls.at(-1)?.[1]?.usage).toBe(vi.mocked(aiUsage).mock.results[0]?.value);
  });

  it("falls back to a deterministic brief when Gemini returns nothing", async () => {
    mocked.mockResolvedValue(null);
    const hub = node({ id: "hub", type: "hub", channel: "newsletter", body: "hub body" });
    const spoke = node({ id: "s1", type: "spoke", channel: "linkedin", framework: "listicle" });
    const graph: ContentGraph = { nodes: [hub, spoke], edges: [edge("hub", "s1")] };
    const { brief } = await generateNodeBrief(
      { ctx, workspaceId: "ws1", plan: plan(graph), node: spoke },
      noRag,
    );
    expect(brief.length).toBeGreaterThan(0);
    expect(brief).toContain("linkedin");
    expect(brief).toContain("connected content"); // has ancestors → references them
  });
});
