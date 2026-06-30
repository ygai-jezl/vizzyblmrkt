import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Gemini; keep parseFirstJson real-ish. The pipeline calls generateText once
// per stage (analyze → templatize → optional repair), so tests sequence the mock.
vi.mock("@/lib/agents/gemini", () => ({
  generateText: vi.fn(),
  generateTextWithImage: vi.fn(),
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

import { templatizeIdea } from "./templatize";
import { generateText } from "@/lib/agents/gemini";

const mocked = vi.mocked(generateText);

const analyzeJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    framework: "listicle",
    blockType: "takeaway-list",
    moduleSize: "medium",
    channel: "linkedin",
    tier: "spoke",
    category: "educate",
    group: "LinkedIn Spoke",
    rationale: "x",
    ...over,
  });

describe("templatizeIdea (two-stage modular pipeline)", () => {
  beforeEach(() => mocked.mockReset());

  it("classifies + produces a framework-guided template with reconciled placeholders", async () => {
    mocked
      .mockResolvedValueOnce(analyzeJson())
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "Do these",
          body: "Do these:\n- {{Thing}}\n- {{Thing}}",
          placeholders: [{ token: "Thing", kind: "list-item" }],
        }),
      );
    const r = await templatizeIdea({ text: "do x, do y", knownGroups: [] });
    expect(r.source).toBe("agent3");
    expect(r.framework).toBe("listicle");
    expect(r.blockType).toBe("takeaway-list");
    expect(r.channel).toBe("linkedin");
    expect(r.tier).toBe("spoke");
    expect(r.placeholders).toHaveLength(1);
    expect(r.placeholders[0]?.token).toBe("Thing");
    expect(r.placeholders[0]?.repeatable).toBe(true); // recurs in the body
  });

  it("honours a framework override regardless of the analysis", async () => {
    mocked
      .mockResolvedValueOnce(analyzeJson({ framework: "contrarian" }))
      .mockResolvedValueOnce(
        JSON.stringify({ title: "T", body: "{{Hook}}", placeholders: [{ token: "Hook" }] }),
      );
    const r = await templatizeIdea({ text: "x", knownGroups: [], framework: "story-pas" });
    expect(r.framework).toBe("story-pas");
  });

  it("adds body tokens the model omitted (body is authoritative)", async () => {
    mocked
      .mockResolvedValueOnce(analyzeJson())
      .mockResolvedValueOnce(
        JSON.stringify({ title: "T", body: "{{A}} and {{B}}", placeholders: [{ token: "A" }] }),
      );
    const r = await templatizeIdea({ text: "x", knownGroups: [] });
    expect(r.placeholders.map((p) => p.token).sort()).toEqual(["A", "B"]);
  });

  it("runs ONE repair pass when the skeleton has no tokens", async () => {
    mocked
      .mockResolvedValueOnce(analyzeJson())
      .mockResolvedValueOnce(JSON.stringify({ title: "T", body: "no tokens at all", placeholders: [] }))
      .mockResolvedValueOnce(
        JSON.stringify({ title: "T", body: "now {{X}} works", placeholders: [{ token: "X" }] }),
      );
    const r = await templatizeIdea({ text: "x", knownGroups: [] });
    expect(r.body).toContain("{{X}}");
    expect(mocked).toHaveBeenCalledTimes(3);
  });

  it("falls back deterministically when the templatize stage fails", async () => {
    mocked.mockResolvedValueOnce(analyzeJson()).mockResolvedValueOnce(null);
    const r = await templatizeIdea({ text: "raw idea content", knownGroups: [] });
    expect(r.source).toBe("fallback");
    expect(r.body).toContain("raw idea");
  });

  it("defaults metadata when analysis is unavailable", async () => {
    mocked
      .mockResolvedValueOnce(null) // analyze fails
      .mockResolvedValueOnce(
        JSON.stringify({ title: "T", body: "{{X}}", placeholders: [{ token: "X" }] }),
      );
    const r = await templatizeIdea({ text: "x", knownGroups: [] });
    expect(r.source).toBe("agent3");
    expect(r.framework).toBeTruthy();
    expect(r.category).toBe("educate");
  });
});
