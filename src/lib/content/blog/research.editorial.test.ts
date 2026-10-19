import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { researchBlogBrief } from "./research";
import { SAMPLE_BRIEF } from "./testing/sampleArticle";

afterEach(() => vi.unstubAllEnvs());

const plan = {
  id: "p1",
  name: "Visibility guide",
  strategy: { objective: "brand_visibility", hubUrl: null, subscriberCount: null },
  scope: { topics: [], spark: "Weekly is enough for most teams.", industryLens: "" },
  knowledge: { groundingScope: "global", proofAssets: [] },
  topology: { hubChannel: "blog", spokeChannels: [] },
  blog: { ...SAMPLE_BRIEF, primaryQuestion: "How often should you check your AI search visibility?" },
} as unknown as ContentPlan;

async function questionsPrompt(onBrief?: (b: unknown) => void): Promise<string> {
  const grounded = vi.fn(async () => ({ text: "", model: "m", sources: [], supports: [] }));
  const r = await researchBlogBrief(
    {
      ctx: { tenantId: "ten_x", region: "us" } as never,
      workspace: { id: "ws1", name: "Acme programme", audience: "Heads of marketing" },
      plan,
      brandName: "Acme",
      ownSites: ["acme.example"],
    },
    {
      grounded: grounded as never,
      retrieve: (async () => ({ formatted: "", chunks: [] })) as never,
      sitePages: async () => ({ pages: [], repoPaths: [] }),
      robots: async () => null,
      now: () => new Date("2026-10-07T09:00:00.000Z"),
    },
  );
  onBrief?.(r.brief);
  return grounded.mock.calls.map((c) => String((c as unknown[])[0])).find((p) => p.includes("ENTITY: <name>")) ?? "";
}

describe("research for an editorial article (CREATE_BLOG_EDITORIAL_ENABLED)", () => {
  it("stays on the article's question: no spread of intents, alternatives only when choosing a product", async () => {
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
    const prompt = await questionsPrompt();
    expect(prompt).toContain("Stay on the article's question");
    expect(prompt).toContain("ONLY when the question is about choosing a product");
    expect(prompt).not.toContain("spread across these intents");
  });

  it("asks as before with the switch off", async () => {
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    const prompt = await questionsPrompt();
    expect(prompt).toContain("The 6 questions they ask NEXT, spread across these intents");
  });
});

describe("research for the editorial writer", () => {
  it("marks the brief, so an article researched before is researched again", async () => {
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    let brief: { researchStyle?: string } = {};
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
    await questionsPrompt((b) => (brief = b as typeof brief));
    expect(brief.researchStyle).toBe("editorial");
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "false");
    await questionsPrompt((b) => (brief = b as typeof brief));
    expect(brief.researchStyle).toBeUndefined();
  });
});
