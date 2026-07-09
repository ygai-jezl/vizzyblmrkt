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

import { generateEbookToc, type EbookTocInput } from "./ebookToc";
import { generateText } from "@/lib/agents/gemini";
import { CONTENT_PLAN_LIMITS } from "@/lib/types/contentPlan";

const mocked = vi.mocked(generateText);

const baseInput: EbookTocInput = {
  spark: "Why founders should write weekly",
  topicLabels: ["Writing", "Audience"],
  industryLens: "B2B SaaS",
  knowledgeContext: "",
  brandVoice: null,
  audience: null,
  fallbackTitle: "My Workflow",
};

describe("generateEbookToc", () => {
  beforeEach(() => mocked.mockReset());

  it("builds a doc with titled chapters (ids assigned, tocConfirmed false)", async () => {
    mocked.mockResolvedValue(
      JSON.stringify({
        title: "The Weekly Writing Playbook",
        subtitle: "Compound trust one post at a time",
        chapters: [
          { title: "Why write weekly", summary: "the case" },
          { title: "Finding your angle", summary: "the spark" },
        ],
      }),
    );
    const ebook = await generateEbookToc(baseInput);
    expect(ebook.title).toBe("The Weekly Writing Playbook");
    expect(ebook.subtitle).toBe("Compound trust one post at a time");
    expect(ebook.industryLens).toBe("B2B SaaS");
    expect(ebook.tocConfirmed).toBe(false);
    expect(ebook.chapters).toHaveLength(2);
    expect(ebook.chapters.every((c) => c.id.length > 0 && c.status === "planned" && c.bodyHtml === "")).toBe(true);
    // ids are unique
    expect(new Set(ebook.chapters.map((c) => c.id)).size).toBe(2);
  });

  it("falls back to a topic-derived ToC when Gemini returns nothing", async () => {
    mocked.mockResolvedValue(null);
    const ebook = await generateEbookToc(baseInput);
    expect(ebook.title).toBe("My Workflow");
    expect(ebook.chapters.map((c) => c.title)).toEqual(["Writing", "Audience"]);
  });

  it("falls back when the model returns zero valid chapters", async () => {
    mocked.mockResolvedValue(JSON.stringify({ title: "x", chapters: [{ summary: "no title" }] }));
    const ebook = await generateEbookToc(baseInput);
    // fell back to topic labels
    expect(ebook.chapters.map((c) => c.title)).toEqual(["Writing", "Audience"]);
  });

  it("caps chapter count at MAX_CHAPTERS", async () => {
    const chapters = Array.from({ length: CONTENT_PLAN_LIMITS.MAX_CHAPTERS + 5 }, (_, i) => ({
      title: `Chapter ${i}`,
      summary: "s",
    }));
    mocked.mockResolvedValue(JSON.stringify({ title: "Big Book", chapters }));
    const ebook = await generateEbookToc(baseInput);
    expect(ebook.chapters.length).toBeLessThanOrEqual(CONTENT_PLAN_LIMITS.MAX_CHAPTERS);
  });
});
