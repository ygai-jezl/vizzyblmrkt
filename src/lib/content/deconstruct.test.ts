import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/agents/gemini", () => ({
  generateText: vi.fn(),
  NO_USAGE: {},
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

import { deconstructTemplate } from "./deconstruct";
import { generateText, NO_USAGE } from "@/lib/agents/gemini";

const mocked = vi.mocked(generateText);
const transformJson = JSON.stringify({ title: "T", body: "{{X}}", placeholders: [{ token: "X" }] });

describe("deconstructTemplate", () => {
  beforeEach(() => mocked.mockReset());

  it("transforms a single (non-hub) block into one spoke per channel — no segmentation", async () => {
    mocked.mockResolvedValue(transformJson);
    const spokes = await deconstructTemplate({
      template: { body: "a strong hook", blockType: "hook", tier: "standalone" },
      channels: ["linkedin", "x"],
      usage: NO_USAGE,
    });
    expect(spokes).toHaveLength(2);
    expect(spokes.map((s) => s.channel).sort()).toEqual(["linkedin", "x"]);
    expect(spokes.every((s) => s.format && s.placeholders.length === 1)).toBe(true);
  });

  it("segments a hub then transforms each block × channel", async () => {
    mocked
      .mockResolvedValueOnce(
        JSON.stringify({
          blocks: [
            { blockType: "hook", excerpt: "h" },
            { blockType: "cta", excerpt: "c" },
          ],
        }),
      )
      .mockResolvedValue(transformJson);
    const spokes = await deconstructTemplate({
      template: { body: "long pillar content", blockType: "full-post", tier: "hub" },
      channels: ["linkedin"],
      usage: NO_USAGE,
    });
    expect(spokes).toHaveLength(2); // 2 blocks × 1 channel
  });

  it("returns [] for empty content or no channels", async () => {
    expect(await deconstructTemplate({ template: { body: "" }, channels: ["x"], usage: NO_USAGE })).toEqual([]);
    expect(await deconstructTemplate({ template: { body: "x" }, channels: [], usage: NO_USAGE })).toEqual([]);
  });

  it("drops failed transforms", async () => {
    mocked.mockResolvedValueOnce(transformJson).mockResolvedValueOnce(null);
    const spokes = await deconstructTemplate({
      template: { body: "hook", blockType: "hook", tier: "standalone" },
      channels: ["linkedin", "x"],
      usage: NO_USAGE,
    });
    expect(spokes).toHaveLength(1);
  });
});
