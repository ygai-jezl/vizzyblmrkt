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

import { architectPlan, type ArchitectInput } from "./architect";
import { generateText } from "@/lib/agents/gemini";
import { CORE_ANGLES } from "@/lib/content/frameworks";

const mocked = vi.mocked(generateText);

const baseInput: ArchitectInput = {
  objective: "newsletter_signups",
  spark: "Why founders should write weekly",
  topicLabels: ["Writing"],
  hubChannel: "newsletter",
  spokeChannels: ["linkedin", "x"],
  knowledgeContext: "",
  brandVoice: null,
  audience: null,
};

describe("architectPlan", () => {
  beforeEach(() => mocked.mockReset());

  it("builds hub + promos + an (angle × channel) spoke matrix from the proposed angles", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({
        nodes: [
          { type: "promo_pre", channel: "linkedin", blockType: "hook", brief: "tease it" },
          { type: "hub", channel: "newsletter", blockType: "full-post", brief: "the pillar" },
          { type: "promo_post", channel: "linkedin", blockType: "cta", brief: "drive clicks" },
        ],
        angles: [
          { id: "listicle", brief: "li brief" },
          { id: "observation", brief: "obs brief" },
        ],
      }),
    );
    const { nodes, edges } = await architectPlan(baseInput);
    // 2 proposed angles × 2 channels = 4 spokes, plus pre/hub/post.
    expect(nodes.map((n) => n.type)).toEqual([
      "promo_pre",
      "hub",
      "promo_post",
      "spoke",
      "spoke",
      "spoke",
      "spoke",
    ]);
    expect(nodes.every((n) => n.status === "empty" && n.body === "")).toBe(true);
    const hub = nodes.find((n) => n.type === "hub")!;
    expect(hub.brief).toBe("the pillar");
    expect(hub.framework ?? null).toBeNull(); // hub carries no angle
    // Every proposed angle rendered for every selected channel.
    const spokes = nodes.filter((n) => n.type === "spoke");
    expect(spokes.map((s) => `${s.framework}:${s.channel}`).sort()).toEqual(
      ["listicle:linkedin", "listicle:x", "observation:linkedin", "observation:x"].sort(),
    );
    // pre→hub, hub→post, hub→each spoke = 6 edges; hub has 5 outgoing.
    expect(edges).toHaveLength(6);
    expect(edges.filter((e) => e.source === hub.id)).toHaveLength(5);
  });

  it("falls back to the full core-angle matrix when Gemini returns nothing", async () => {
    mocked.mockResolvedValue(null);
    const { nodes } = await architectPlan(baseInput);
    // 5 core angles × 2 channels = 10 spokes, + pre/hub/post = 13.
    expect(nodes).toHaveLength(13);
    expect(nodes.filter((n) => n.type === "spoke")).toHaveLength(10);
    expect(nodes.map((n) => n.type).slice(0, 3)).toEqual(["promo_pre", "hub", "promo_post"]);
    // Every fallback spoke carries a CORE angle; every node has a populated brief.
    expect(
      nodes
        .filter((n) => n.type === "spoke")
        .every((n) => (CORE_ANGLES as readonly string[]).includes(n.framework ?? "")),
    ).toBe(true);
    expect(nodes.every((n) => (n.brief ?? "").length > 0)).toBe(true);
  });

  it("dedupes proposed angles and drops ids outside the core library", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({
        nodes: [{ type: "hub", channel: "newsletter", blockType: "full-post", brief: "h" }],
        angles: [
          { id: "listicle", brief: "a" },
          { id: "listicle", brief: "dup" }, // duplicate
          { id: "how-to", brief: "not a core angle" }, // valid framework, not core
          { id: "bogus", brief: "invalid" }, // not a framework at all
        ],
      }),
    );
    const { nodes } = await architectPlan(baseInput);
    const spokes = nodes.filter((n) => n.type === "spoke");
    // Only "listicle" survives → 1 angle × 2 channels = 2 spokes.
    expect(spokes).toHaveLength(2);
    expect([...new Set(spokes.map((s) => s.framework))]).toEqual(["listicle"]);
  });

  it("filters invalid channels and defaults the promo channel when no spokes", async () => {
    mocked.mockResolvedValue(null);
    const { nodes } = await architectPlan({
      ...baseInput,
      spokeChannels: ["not-a-channel"],
    });
    expect(nodes.filter((n) => n.type === "spoke")).toHaveLength(0);
    const pre = nodes.find((n) => n.type === "promo_pre")!;
    expect(pre.channel).toBe("linkedin"); // DEFAULT_PROMO_CHANNEL
  });

  it("auto-selects a matching workspace template per node (channel + tier)", async () => {
    mocked.mockResolvedValue(null);
    const { nodes } = await architectPlan({
      ...baseInput,
      templates: [
        { id: "t-hub", channel: "newsletter", tier: "hub", blockType: "full-post" },
        { id: "t-li", channel: "linkedin", tier: "spoke", blockType: "takeaway-list" },
      ],
    });
    expect(nodes.find((n) => n.type === "hub")!.templateId).toBe("t-hub");
    expect(nodes.find((n) => n.type === "spoke" && n.channel === "linkedin")!.templateId).toBe("t-li");
    // No template for X → composes freely.
    expect(nodes.find((n) => n.type === "spoke" && n.channel === "x")!.templateId).toBeNull();
  });

  it("leaves templateId null when no templates are provided", async () => {
    mocked.mockResolvedValue(null);
    const { nodes } = await architectPlan(baseInput);
    expect(nodes.every((n) => n.templateId === null)).toBe(true);
  });

  it("ignores a model blockType that isn't a real block id", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({ nodes: [{ type: "hub", channel: "newsletter", blockType: "bogus", brief: "x" }] }),
    );
    const { nodes } = await architectPlan({ ...baseInput, spokeChannels: [] });
    expect(nodes.find((n) => n.type === "hub")!.blockType).toBe("full-post");
  });
});
