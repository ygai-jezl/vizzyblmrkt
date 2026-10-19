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

describe("the author in the suggested markup", () => {
  it("is a Person with their role and their own profile page", async () => {
    const { suggestBlogSchema } = await import("./schema");
    const { jsonLd } = suggestBlogSchema({ markdown: EDITORIAL_ARTICLE, brief: EDITORIAL_BRIEF, pageUrl: "https://acme.example/blog/how-often" });
    const posting = (jsonLd!["@graph"] as Record<string, unknown>[]).find((n) => n["@type"] === "BlogPosting")!;
    expect(posting.author).toEqual({ "@type": "Person", name: "Ana Ruiz", jobTitle: "Head of Growth", url: "https://acme.example/team/ana" });
    const { notes } = suggestBlogSchema({ markdown: EDITORIAL_ARTICLE, brief: { ...EDITORIAL_BRIEF, authorUrl: "" } });
    expect(notes.some((n) => n.includes("Ana Ruiz's profile page"))).toBe(true);
  });
});

describe("the brand's notes in an editorial article", () => {
  const withNotes = {
    ...EDITORIAL_BRIEF,
    seen: {
      notes: [
        { id: "bn_1", text: "Harbor's citations fell 40% in the fortnight after a rival's comparison page.", why: "", canName: true },
        { id: "bn_2", text: "A customer only found out from a prospect.", why: "", canName: false },
      ],
      near: [],
      removed: [],
      own: "We stopped checking daily after a month.",
      save: true,
      asks: [],
      matchedFor: "",
      matchedAt: null,
    },
  };

  it("are the only experience the writer may claim, each marked whether people in it may be named", async () => {
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
    const generate = vi.fn(async () => answer.replace("Most teams should check weekly", "Most teams should check weekly; one brand's citations fell 40% in a fortnight"));
    const draft = await draftBlogArticle(input({ brief: withNotes }), { generate, now: NOW });
    const prompt = String((generate.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain("WHAT WE'VE SEEN");
    expect(prompt).toContain("[1] (the people in it may be named) Harbor's citations fell 40%");
    expect(prompt).toContain("[2] (keep every person and company in it anonymous) A customer only found out");
    expect(prompt).toContain("[3] (what the team wrote for this article; keep every person and company in it anonymous) We stopped checking daily");
    expect(prompt).not.toContain("Claim no experience of its own");
    // A figure from a note is traceable.
    expect(draft!.meta.unsupportedFigures).not.toContain("40%");
  });

  it("back first-hand claims in the fact check, which is told to check them", async () => {
    const generate = vi.fn(async () => "OK");
    await checkBlogFacts(
      {
        plan: { ...plan, blog: withNotes } as unknown as ContentPlan,
        node: { ...node, body: EDITORIAL_ARTICLE, blog: { style: "editorial" } } as unknown as ContentNode,
        brief: withNotes,
        brandName: "Acme",
        knowledgeContext: "",
        knowledgeUrls: [],
        proofBlock: "",
      },
      { generate, now: NOW },
    );
    const prompt = String((generate.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain("5. Any claim of the brand's own first-hand experience");
    expect(prompt).toContain("- A customer only found out from a prospect.");
  });
});

describe("what the editorial writer is shown of the brand's knowledge", () => {
  it("leaves out what was learned from a code repo; the CITABLE writer is shown it as before", async () => {
    const { formatContext } = await import("@/lib/agents/knowledgeRetrieval");
    const knowledgeContext = formatContext([
      { title: "Product", sourceUri: "https://acme.example/product", content: "Acme Visibility runs the same questions on a schedule.", path: null, heading: null, topic: null, tags: [] },
      { title: "README", sourceUri: "https://github.com/acme/app/blob/HEAD/README.md", content: "Prompts are deduplicated by a SHA-256 hash.", path: null, heading: null, topic: null, tags: [] },
    ]);
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
    const editorial = vi.fn(async () => answer);
    await draftBlogArticle(input({ knowledgeContext }), { generate: editorial, now: NOW });
    const shown = String((editorial.mock.calls[0] as unknown[])[0]);
    expect(shown).toContain("runs the same questions on a schedule");
    expect(shown).not.toContain("SHA-256");
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "false");
    const citable = vi.fn(async () => answer);
    await draftBlogArticle(input({ knowledgeContext, brief: SAMPLE_BRIEF }), { generate: citable, now: NOW });
    expect(String((citable.mock.calls[0] as unknown[])[0])).toContain("SHA-256");
  });
});

describe("an editorial article from a brief researched before the editorial writer", () => {
  it("is not handed research's alternatives, definitions or a page's slogan", async () => {
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    vi.stubEnv("CREATE_BLOG_EDITORIAL_ENABLED", "true");
    const old = {
      ...EDITORIAL_BRIEF,
      questions: [
        { question: "What is AI search visibility?", intent: "definition" as const, by: "research" as const },
        { question: "What are the top alternatives to Rivalco?", intent: "alternatives" as const, by: "research" as const },
        { question: "Why do answers change from day to day?", intent: "other" as const, by: "research" as const },
      ],
      links: [...EDITORIAL_BRIEF.links, { url: "https://acme.example/waitlist", label: "Speak Fluent AI. No Code Required.", intent: "convert" as const, by: "research" as const }],
    };
    const generate = vi.fn(async () => answer);
    await draftBlogArticle(input({ brief: old }), { generate, now: NOW });
    const prompt = String((generate.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain("Why do answers change from day to day?");
    expect(prompt).not.toContain("alternatives to Rivalco");
    expect(prompt).not.toContain("What is AI search visibility?");
    // Not as a question, and not as a company to name.
    expect(prompt).not.toContain("Rivalco");
    expect(prompt).not.toContain("Speak Fluent AI");
    expect(prompt).toContain("Waitlist page");
  });
});
