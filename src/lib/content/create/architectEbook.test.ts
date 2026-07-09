import { describe, it, expect, vi } from "vitest";

// architect.ts imports gemini at module load (architectPlan/Sequence use it); architectEbookPlan
// itself makes NO model call, but we still stub the module so the import is cheap + offline.
vi.mock("@/lib/agents/gemini", () => ({
  generateText: vi.fn().mockResolvedValue(null),
  parseFirstJson: () => null,
}));

import { architectEbookPlan } from "./architect";
import { CORE_ANGLES } from "@/lib/content/frameworks";
import type { EbookDoc } from "@/lib/types/contentPlan";

const ebook: EbookDoc = {
  title: "The Weekly Writing Playbook",
  subtitle: "Compound trust one post at a time",
  industryLens: "B2B SaaS",
  tocConfirmed: true,
  chapters: [
    { id: "c1", title: "Why write weekly", summary: "the case", bodyHtml: "<h2>Why</h2>", status: "confirmed", images: [] },
    { id: "c2", title: "Finding your angle", summary: "the spark", bodyHtml: "<h2>Angle</h2>", status: "confirmed", images: [] },
  ],
};

describe("architectEbookPlan", () => {
  it("makes the eBook the hub (generated, carrying the book) with pre/post promos + a spoke web", async () => {
    const { nodes, edges } = await architectEbookPlan({
      spark: "Why founders should write weekly",
      spokeChannels: ["linkedin", "x"],
      ebook,
    });

    const hub = nodes.find((n) => n.type === "hub")!;
    expect(hub.channel).toBe("ebook");
    expect(hub.status).toBe("generated");
    expect(hub.ebook?.title).toBe(ebook.title);
    expect(hub.body.length).toBeGreaterThan(0); // synopsis
    // The hub carries only a LIGHT ToC skeleton — chapter titles/summaries but NO heavy prose
    // or image slots (the full book stays on ContentPlan.ebookDraft to avoid double-storage).
    expect(hub.ebook?.chapters).toHaveLength(ebook.chapters.length);
    expect(hub.ebook?.chapters.every((c) => c.bodyHtml === "" && c.images.length === 0)).toBe(true);
    expect(hub.ebook?.chapters.map((c) => c.title)).toEqual(ebook.chapters.map((c) => c.title));

    // 5 core angles × 2 channels = 10 spokes + pre/hub/post = 13.
    expect(nodes.filter((n) => n.type === "spoke")).toHaveLength(CORE_ANGLES.length * 2);
    expect(nodes.map((n) => n.type).slice(0, 3)).toEqual(["promo_pre", "hub", "promo_post"]);

    // Edges: pre→hub, hub→post, hub→each spoke.
    const spokes = nodes.filter((n) => n.type === "spoke");
    expect(edges).toHaveLength(2 + spokes.length);
    expect(edges.filter((e) => e.source === hub.id)).toHaveLength(1 + spokes.length);
    // Every spoke carries a core angle.
    expect(spokes.every((s) => (CORE_ANGLES as readonly string[]).includes(s.framework ?? ""))).toBe(true);
  });

  it("filters invalid channels and defaults the promo channel when no spokes", async () => {
    const { nodes } = await architectEbookPlan({
      spark: "",
      spokeChannels: ["not-a-channel"],
      ebook,
    });
    expect(nodes.filter((n) => n.type === "spoke")).toHaveLength(0);
    expect(nodes.find((n) => n.type === "promo_pre")!.channel).toBe("linkedin");
  });
});
