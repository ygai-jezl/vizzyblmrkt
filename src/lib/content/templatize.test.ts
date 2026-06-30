import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Gemini layer so templatizeIdea is tested without network. parseFirstJson
// keeps its real behaviour (the parsing is part of what we're verifying).
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

describe("templatizeIdea", () => {
  beforeEach(() => {
    vi.mocked(generateText).mockReset();
  });

  it("parses a valid Gemini JSON response", async () => {
    vi.mocked(generateText).mockResolvedValue(
      JSON.stringify({ title: "T", body: "Hello {{X}}", category: "challenge", group: "Twitter Thread" }),
    );
    const r = await templatizeIdea({ text: "some content", knownGroups: ["Twitter Thread"] });
    expect(r.source).toBe("agent3");
    expect(r.category).toBe("challenge");
    expect(r.group).toBe("Twitter Thread");
    expect(r.body).toContain("{{X}}");
  });

  it("defaults an invalid category to educate", async () => {
    vi.mocked(generateText).mockResolvedValue(
      JSON.stringify({ title: "T", body: "B", category: "inform", group: "G" }),
    );
    const r = await templatizeIdea({ text: "x", knownGroups: [] });
    expect(r.category).toBe("educate");
  });

  it("falls back deterministically when Gemini returns null", async () => {
    vi.mocked(generateText).mockResolvedValue(null);
    const r = await templatizeIdea({ text: "raw idea text", knownGroups: [] });
    expect(r.source).toBe("fallback");
    expect(r.body).toContain("raw idea");
    expect(r.category).toBe("educate");
  });

  it("falls back when JSON is missing required fields", async () => {
    vi.mocked(generateText).mockResolvedValue('{"category":"educate"}');
    const r = await templatizeIdea({ text: "content here", knownGroups: [] });
    expect(r.source).toBe("fallback");
  });
});
