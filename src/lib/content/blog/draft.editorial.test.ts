import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { authorBox, bylineOf, draftBlogArticle, splitAuthorBox, stampDateLine, type BlogDraftInput } from "./draft";
import { checkBlogFacts } from "./factCheck";
import { outlineArticle } from "./outline";
import { EDITORIAL_ARTICLE, EDITORIAL_BRIEF } from "./testing/editorialArticle";
import { SAMPLE_BRIEF } from "./testing/sampleArticle";

afterEach(() => vi.unstubAllEnvs());

const node = { id: "hub", type: "hub", channel: "blog", role: "Hub", brief: "Explain it.", body: "" } as unknown as ContentNode;
const plan = {
  id: "p1",
  name: "Visibility guide",
  strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/blog/visibility", subscriberCount: null },
  scope: { topics: [], spark: "Weekly is enough for most teams.", industryLens: "" },
  knowledge: { groundingScope: "global", proofAssets: [] },
} as unknown as ContentPlan;

const input = (over: Partial<BlogDraftInput> = {}): BlogDraftInput => ({
  plan,
  node,
  brief: EDITORIAL_BRIEF,
  brandName: "Acme",
  knowledgeContext: "[Source: Product — https://acme.example/product]\nAcme Visibility runs the same questions on a schedule.",
  knowledgeUrls: ["https://acme.example/product"],
  proofBlock: "",
  quick: true,
  ...over,
});

const BOX = "## About the author\n\n**Ana Ruiz**, Head of Growth\n\nAna has run growth at two software companies and now leads it at Acme.";

/** What the writer sends back: the article with an old date, no byline, and its own author section. */
const WRITTEN = splitAuthorBox(EDITORIAL_ARTICLE)
  .body.replace("*Last updated: 2026-10-07 · By Ana Ruiz, Head of Growth*", "*Last updated: 2024-01-01*")
  .concat("\n\n## About the author\n\nWritten by the team.");
const answer = `META_TITLE: How often to check AI search visibility\nMETA_DESCRIPTION: Weekly, for most teams.\nSLUG: how-often\n---\n${WRITTEN}`;

const NOW = () => new Date("2026-10-07T09:00:00.000Z");

describe("the editorial writer (CREATE_BLOG_EDITORIAL_ENABLED)", () => {
  it("is asked for an editorial article, told who it is published under, and told it may claim no experience", async () => {
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
    const generate = vi.fn(async () => answer);
    await draftBlogArticle(input(), { generate, now: NOW });
    const prompt = String((generate.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain("Write as a practitioner talking to a peer");
    expect(prompt).toContain("Published under: Ana Ruiz, Head of Growth, at Acme");
    expect(prompt).toContain("Claim no experience of its own");
    expect(prompt).not.toContain("> **Key facts**");
    expect(prompt).toContain('"leverage"');
  });

  it("stamps the date with the byline, adds the author box once in the author's own words, and marks the article editorial", async () => {
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
    const draft = await draftBlogArticle(input(), { generate: async () => answer, now: NOW });
    expect(draft).not.toBeNull();
    expect(draft!.body).toContain("*Last updated: 2026-10-07 · By Ana Ruiz, Head of Growth*");
    expect(draft!.body.endsWith(BOX)).toBe(true);
    expect(draft!.body.match(/## About the author/g)).toHaveLength(1);
    expect(draft!.body).not.toContain("Written by the team.");
    expect(draft!.meta.style).toBe("editorial");
    // The date line is still read as the date, and the box is not a section of the article.
    const o = outlineArticle(draft!.body);
    expect(o.lastUpdated).toBe("2026-10-07");
    expect(o.sections.map((s) => s.heading)).not.toContain("About the author");
  });

  it("writes the CITABLE structure, unmarked, with the switch off", async () => {
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    const generate = vi.fn(async () => answer);
    const draft = await draftBlogArticle(input({ brief: SAMPLE_BRIEF }), { generate, now: NOW });
    expect(String((generate.mock.calls[0] as unknown[])[0])).toContain("> **Key facts**");
    expect(draft!.meta.style).toBeUndefined();
    // No byline and no code-built box: what the writer wrote is left exactly as before.
    expect(draft!.body).toContain("*Last updated: 2026-10-07*");
    expect(draft!.body).not.toContain("two software companies");
  });

  it("leaves the byline and the box out when the brand is the author", () => {
    expect(bylineOf(SAMPLE_BRIEF)).toBe("");
    expect(authorBox(SAMPLE_BRIEF)).toBe("");
    expect(authorBox({ ...EDITORIAL_BRIEF, authorBio: "" })).toBe("");
    expect(stampDateLine("# T\n\nBody.", "2026-10-07", "")).toBe("# T\n\n*Last updated: 2026-10-07*\n\nBody.");
    // Markdown in a name can't break the line.
    expect(bylineOf({ ...EDITORIAL_BRIEF, author: "*Ana* [Ruiz]", authorRole: "" })).toBe("By Ana Ruiz");
  });
});

describe("the fact check on an editorial article", () => {
  it("never checks the author box, and puts it back after the check", async () => {
    const body = draftBody();
    const generate = vi.fn(async () => "OK");
    const result = await checkBlogFacts(
      {
        plan: { ...plan, blog: EDITORIAL_BRIEF } as unknown as ContentPlan,
        node: { ...node, body, blog: { style: "editorial" } } as unknown as ContentNode,
        brief: EDITORIAL_BRIEF,
        brandName: "Acme",
        knowledgeContext: "",
        knowledgeUrls: [],
        proofBlock: "",
      },
      { generate, now: NOW },
    );
    expect(String((generate.mock.calls[0] as unknown[])[0])).not.toContain("two software companies");
    expect(result.body.endsWith(BOX)).toBe(true);
  });
});

function draftBody(): string {
  return EDITORIAL_ARTICLE;
}
