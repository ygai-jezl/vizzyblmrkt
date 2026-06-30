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

  it("builds the canonical hub-and-spoke skeleton (pre/hub/post + 1 spoke/channel)", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({
        nodes: [
          { type: "promo_pre", channel: "linkedin", blockType: "hook", brief: "tease it" },
          { type: "hub", channel: "newsletter", blockType: "full-post", brief: "the pillar" },
          { type: "promo_post", channel: "linkedin", blockType: "cta", brief: "drive clicks" },
          { type: "spoke", channel: "linkedin", blockType: "takeaway-list", brief: "li angle" },
          { type: "spoke", channel: "x", blockType: "data-point", brief: "x angle" },
        ],
      }),
    );
    const { nodes, edges } = await architectPlan(baseInput);
    expect(nodes.map((n) => n.type)).toEqual(["promo_pre", "hub", "promo_post", "spoke", "spoke"]);
    expect(nodes.every((n) => n.status === "empty" && n.body === "")).toBe(true);
    const hub = nodes.find((n) => n.type === "hub")!;
    expect(hub.brief).toBe("the pillar");
    expect(nodes.find((n) => n.channel === "x")!.brief).toBe("x angle");
    // pre→hub, hub→post, hub→each spoke = 4 edges
    expect(edges).toHaveLength(4);
    expect(edges.filter((e) => e.source === hub.id)).toHaveLength(3); // post + 2 spokes
  });

  it("falls back to a deterministic skeleton when Gemini returns nothing", async () => {
    mocked.mockResolvedValue(null);
    const { nodes } = await architectPlan(baseInput);
    expect(nodes).toHaveLength(5); // pre + hub + post + 2 spokes (linkedin, x)
    expect(nodes.map((n) => n.type)).toEqual([
      "promo_pre",
      "hub",
      "promo_post",
      "spoke",
      "spoke",
    ]);
    // briefs are populated by the fallback
    expect(nodes.every((n) => (n.brief ?? "").length > 0)).toBe(true);
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

  it("ignores a model blockType that isn't a real block id", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({ nodes: [{ type: "hub", channel: "newsletter", blockType: "bogus", brief: "x" }] }),
    );
    const { nodes } = await architectPlan({ ...baseInput, spokeChannels: [] });
    expect(nodes.find((n) => n.type === "hub")!.blockType).toBe("full-post");
  });
});
