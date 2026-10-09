import { describe, expect, it, vi } from "vitest";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { draftBlogArticle, enforceLinks, parseDraft, stampLastUpdated, type BlogDraftInput } from "./draft";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";

const node = { id: "hub", type: "hub", channel: "blog", role: "Hub", brief: "Explain it.", body: "" } as unknown as ContentNode;
const plan = {
  id: "p1",
  name: "Visibility guide",
  strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/blog/visibility", subscriberCount: null },
  scope: { topics: [], spark: "Buyers ask AI assistants for shortlists.", industryLens: "" },
  knowledge: { groundingScope: "global", proofAssets: [] },
} as unknown as ContentPlan;

const KNOWLEDGE =
  "[Source: Customer story — https://acme.example/customers/harbor]\nHarbor's share of voice rose from 6% to 21%.";

const input = (over: Partial<BlogDraftInput> = {}): BlogDraftInput => ({
  plan,
  node,
  brief: SAMPLE_BRIEF,
  brandName: "Acme",
  knowledgeContext: KNOWLEDGE,
  knowledgeUrls: ["https://acme.example/customers/harbor", "https://github.com/acme/app/blob/HEAD/README.md"],
  proofBlock: "",
  ...over,
});

const answer = (article: string) =>
  `META_TITLE: AI search visibility monitoring, explained\nMETA_DESCRIPTION: What it is and how to choose a tool.\nSLUG: AI Search Visibility Monitoring!\n---\n${article}`;

/** A clock that advances `stepMs` every time it is read. */
const clock = (stepMs: number) => {
  let t = Date.parse("2026-10-07T09:00:00.000Z");
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
};

describe("the blog writer", () => {
  it("reads the writer's answer, with or without its header", () => {
    expect(parseDraft(answer("# Title\n\nBody."))).toEqual({
      metaTitle: "AI search visibility monitoring, explained",
      metaDescription: "What it is and how to choose a tool.",
      slug: "ai-search-visibility-monitoring",
      body: "# Title\n\nBody.",
    });
    expect(parseDraft("```markdown\n# Title\n\nBody.\n```")).toMatchObject({ metaTitle: "", slug: "", body: "# Title\n\nBody." });
    expect(parseDraft("No title, just prose.").body).toBe("No title, just prose.");
  });

  it("stamps today's date under the title, whatever the writer put there", () => {
    expect(stampLastUpdated("# T\n\n*Last updated: 2024-01-01*\n\nBody.", "2026-10-07")).toBe(
      "# T\n\n*Last updated: 2026-10-07*\n\nBody.",
    );
    expect(stampLastUpdated("# T\n\nBody.", "2026-10-07")).toBe("# T\n\n*Last updated: 2026-10-07*\n\nBody.");
    // A "last updated" further down (inside a section) is copy, not the stamp.
    expect(stampLastUpdated("# T\n\nBody.\n\n## S\n\nLast updated pricing below.", "2026-10-07")).toContain(
      "## S\n\nLast updated pricing below.",
    );
  });

  it("keeps only the links on the lists", () => {
    const allowed = new Set(["https://acme.example/pricing", "https://research.example.org/buyers-2026"]);
    const { body, removed } = enforceLinks(
      "See [pricing](https://acme.example/pricing/) and [a study](https://research.example.org/buyers-2026?utm_source=x), " +
        "not [this](https://made-up.example.com/stat) or https://bare.example.com/page. Jump to [the FAQ](#faq) or {{hub_url}} via [here]({{hub_url}}).",
      allowed,
    );
    expect(body).toBe(
      "See [pricing](https://acme.example/pricing/) and [a study](https://research.example.org/buyers-2026?utm_source=x), " +
        "not this or . Jump to [the FAQ](#faq) or {{hub_url}} via [here]({{hub_url}}).",
    );
    expect(removed).toEqual(["https://made-up.example.com/stat", "https://bare.example.com/page"]);
  });

  it("leaves addresses inside code exactly as written", () => {
    const md = [
      "Set `baseUrl: https://api.example.com/v2` first, not https://stray.example.com/x.",
      "",
      "```yaml",
      "endpoint: https://api.example.com/v2",
      "docs: [the guide](https://unlisted.example.com/guide)",
      "```",
      "",
      "Then read https://after.example.com/next.",
    ].join("\n");
    const { body, removed } = enforceLinks(md, new Set());
    expect(body).toContain("`baseUrl: https://api.example.com/v2`");
    expect(body).toContain("endpoint: https://api.example.com/v2\ndocs: [the guide](https://unlisted.example.com/guide)");
    expect(removed).toEqual(["https://stray.example.com/x", "https://after.example.com/next"]);
  });

  it("writes the article from the brief in one pass when it meets the structure", async () => {
    const generate = vi.fn(async (_prompt: string) =>
      answer(SAMPLE_ARTICLE.replace("*Last updated: 2026-10-07*", "*Last updated: 2020-01-01*")),
    );
    const d = await draftBlogArticle(input(), { generate, now: clock(1000) });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(d).not.toBeNull();
    expect(d!.warnings).toEqual([]);
    expect(d!.report.score).toBe(100);
    expect(d!.body).toContain("*Last updated: 2026-10-07*");
    expect(d!.meta).toMatchObject({
      metaTitle: "AI search visibility monitoring, explained",
      slug: "ai-search-visibility-monitoring",
      lastUpdated: "2026-10-07",
      unsupportedFigures: [],
      removedLinks: [],
      checkedAt: null,
    });

    // The writer is given the brief — and never an unverified source or the brand's code.
    const prompt = String(generate.mock.calls[0]![0]);
    expect(prompt).toContain("How does it differ from SEO rank tracking? [comparison]");
    expect(prompt).toContain("Cite as [Example Research, 2026](https://research.example.org/buyers-2026)");
    expect(prompt).toContain("https://acme.example/pricing [CONVERSION page]");
    expect(prompt).not.toContain("blocked.example.io");
    expect(prompt).toContain("Acme Visibility — the brand's product");
    // The modular "headings are a single noun" rules would fight a question-led article.
    expect(prompt).not.toContain("Modular writing rules");
  });

  it("takes out unlisted links and reports figures nobody can trace", async () => {
    const invented = SAMPLE_ARTICLE.replace(
      "Acme Visibility is an alternative to Rivalco.",
      "Acme Visibility is an alternative to Rivalco, and [one report](https://made-up.example.com/r) says churn fell 38%.",
    );
    const d = await draftBlogArticle(input({ quick: true }), { generate: async () => answer(invented), now: clock(1000) });
    expect(d!.body).not.toContain("made-up.example.com");
    expect(d!.body).toContain("and one report says churn fell 38%.");
    expect(d!.meta.removedLinks).toEqual(["https://made-up.example.com/r"]);
    expect(d!.meta.unsupportedFigures).toEqual(["38%"]);
    expect(d!.warnings).toEqual(["unsupported_figures", "unlisted_links_removed", "citable_gaps"]);
  });

  it("gives a draft that misses the structure one second pass, and keeps the better one", async () => {
    const thin = "# What is AI search visibility monitoring?\n\n" + "A ramble with no structure at all. ".repeat(30);
    const generate = vi.fn().mockResolvedValueOnce(answer(thin)).mockResolvedValueOnce(SAMPLE_ARTICLE);
    const d = await draftBlogArticle(input(), { generate, now: clock(1000) });
    expect(generate).toHaveBeenCalledTimes(2);
    const repair = String(generate.mock.calls[1]![0]);
    expect(repair).toContain("═══ REVISION ═══");
    expect(repair).toContain("Add a Key facts box");
    expect(repair).toContain("<draft>\n# What is AI search visibility monitoring?");
    expect(d!.report.score).toBe(100);
    // The second pass dropped its header lines: the first pass's are kept.
    expect(d!.meta.metaTitle).toBe("AI search visibility monitoring, explained");

    // A second pass that comes back worse is thrown away.
    const worse = vi.fn().mockResolvedValueOnce(answer(thin)).mockResolvedValueOnce("# Nope\n\n" + "x ".repeat(120));
    const kept = await draftBlogArticle(input(), { generate: worse, now: clock(1000) });
    expect(kept!.body).toContain("A ramble with no structure at all.");
    expect(kept!.warnings).toContain("citable_gaps");
  });

  it("does not take a second pass when the caller is in a hurry, or the first was slow", async () => {
    const thin = "# What is AI search visibility monitoring?\n\n" + "A ramble with no structure at all. ".repeat(30);
    const quick = vi.fn(async () => answer(thin));
    await draftBlogArticle(input({ quick: true }), { generate: quick, now: clock(1000) });
    expect(quick).toHaveBeenCalledTimes(1);
    const slow = vi.fn(async () => answer(thin));
    await draftBlogArticle(input(), { generate: slow, now: clock(31_000) });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("gives a title to a draft that forgot one, and fails cleanly on nothing", async () => {
    const untitled = SAMPLE_ARTICLE.replace("# What is AI search visibility monitoring?\n", "");
    const d = await draftBlogArticle(input({ quick: true }), { generate: async () => untitled, now: clock(1000) });
    expect(d!.body.startsWith("# What is AI search visibility monitoring?\n\n*Last updated: 2026-10-07*")).toBe(true);
    expect(await draftBlogArticle(input(), { generate: async () => null })).toBeNull();
    expect(await draftBlogArticle(input(), { generate: async () => "Sorry, I can't." })).toBeNull();
  });

  it("tells the writer to choose on merit when the sources came from the brand's cite sources and the web", async () => {
    const prompts: string[] = [];
    const generate = async (prompt: string) => {
      prompts.push(prompt);
      return SAMPLE_ARTICLE;
    };
    await draftBlogArticle(input({ quick: true }), { generate, now: clock(1000) });
    const withShelf = {
      ...SAMPLE_BRIEF,
      sources: [
        ...SAMPLE_BRIEF.sources,
        {
          url: "https://analyst.example.com/reports/ai-search-2026",
          title: "AI search 2026",
          publisher: "Example Analyst",
          year: 2026,
          fact: "63% of 2,400 buyers surveyed asked an AI assistant for a shortlist.",
          status: "verified" as const,
          origin: "cited" as const,
        },
      ],
    };
    await draftBlogArticle(input({ quick: true, brief: withShelf }), { generate, now: clock(1000) });

    const [plain, both] = prompts as [string, string];
    const note = "it makes no difference which of the two a fact came from";
    // No cite source behind the article: it is asked for exactly as it always was.
    expect(plain).not.toContain(note);
    expect(plain).toContain("SOURCES YOU MAY CITE");
    // One list, in the order research made it, and nothing in it says where a fact came from.
    expect(both).toContain(note);
    expect(both).toContain("- Cite as [Example Analyst, 2026](https://analyst.example.com/reports/ai-search-2026)");
    expect(both).not.toMatch(/origin|cited source|from the web:/i);
    // Taking the new source and the note back out leaves the first prompt, to the letter.
    const added = both.slice(both.indexOf("- Cite as [Example Analyst, 2026]"), both.indexOf("YOUR OWN PAGES YOU MAY LINK TO"));
    expect(both.replace(added, "\n")).toBe(plain);

    // The brand's own research on the shelf is cited the same way — and called what it is.
    const ownFinding = "say it is the brand's own finding, never an outside party's";
    expect(both).not.toContain(ownFinding);
    const withOwn = {
      ...withShelf,
      sources: [
        ...withShelf.sources,
        {
          url: "https://acme.example/research/benchmark-2026",
          title: "Acme benchmark 2026",
          publisher: "Acme",
          year: 2026,
          fact: "Across 180 Acme customers, visibility rose 41% in a quarter.",
          status: "verified" as const,
          origin: "cited" as const,
        },
      ],
    };
    await draftBlogArticle(input({ quick: true, brief: withOwn }), { generate, now: clock(1000) });
    expect(prompts[2]).toContain(ownFinding);
    expect(prompts[2]).toContain("- Cite as [Acme, 2026](https://acme.example/research/benchmark-2026)");
  });
});

