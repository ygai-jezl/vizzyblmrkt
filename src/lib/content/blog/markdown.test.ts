import { describe, expect, it } from "vitest";
import {
  articleLinks,
  countWords,
  inlineLinks,
  lastUpdatedOf,
  parseArticle,
  plainInline,
  renderArticleHtml,
  safeHref,
  slugify,
} from "./markdown";
import { outlineArticle } from "./outline";

const ARTICLE = `# What is AI search visibility monitoring?

*Last updated: 2026-10-07*

AI search visibility monitoring tracks how often a brand is named in AI answers. It is for B2B marketing teams. Use it when buyers research vendors in ChatGPT.

> **Key facts**
> - 40% of B2B buyers use AI assistants for vendor research [Example Research, 2026](https://research.example.com/report)
> - Acme tracks 8 answer engines [Acme](https://acme.example/product)
> - Trials grew from 550 to 2,300 in 4 weeks [Acme](https://acme.example/customers)

> **TL;DR**
> - Monitor the prompts buyers ask.
> - Cite sources.
> - Update quarterly.

## How does it differ from SEO rank tracking?

Rank tracking measures positions on a results page. Visibility monitoring measures whether an answer names you at all.

| Approach | Measures |
| --- | --- |
| Rank tracking | Position |
| Visibility monitoring | Mentions \\| citations |

- One
- Two

## What does it cost?

Plans start low. See [pricing](https://acme.example/pricing).

## Frequently asked questions

### Is it accurate?

Answers vary run to run, so tools sample each prompt several times.

### Who needs it?

Teams whose buyers ask AI assistants for vendor shortlists.

## Next step

[Start a free trial](https://acme.example/signup).

## Sources

1. [AI search report](https://research.example.com/report) — Example Research, 2026
`;

describe("article markdown", () => {
  it("parses headings, boxes, tables and lists into blocks", () => {
    const blocks = parseArticle(ARTICLE);
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, text: "What is AI search visibility monitoring?" });
    const boxes = blocks.filter((b) => b.kind === "callout");
    expect(boxes.map((b) => (b.kind === "callout" ? b.label : ""))).toEqual(["Key facts", "TL;DR"]);
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toEqual({
      kind: "table",
      header: ["Approach", "Measures"],
      rows: [
        ["Rank tracking", "Position"],
        ["Visibility monitoring", "Mentions | citations"],
      ],
    });
    expect(blocks.filter((b) => b.kind === "list").length).toBe(2);
  });

  it("keeps a wrapped list item and a loose list together, and a rule is not a list", () => {
    const blocks = parseArticle("- one\n  continues here\n\n- two\n\n---\n\nAfter.");
    expect(blocks).toEqual([
      { kind: "list", ordered: false, items: ["one continues here", "two"] },
      { kind: "rule" },
      { kind: "paragraph", text: "After." },
    ]);
  });

  it("reads inline text and links, and only follows safe link targets", () => {
    expect(plainInline("**Bold** and *soft* with `code` and [a link](https://a.example/x)")).toBe(
      "Bold and soft with code and a link",
    );
    expect(inlineLinks("See **[pricing](https://a.example/p)** or [docs](/docs).")).toEqual([
      { href: "https://a.example/p", text: "pricing" },
      { href: "/docs", text: "docs" },
    ]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("{{hub_url}}")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(inlineLinks("[x](javascript:alert(1))")).toEqual([]);
    expect(inlineLinks("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { href: "https://en.wikipedia.org/wiki/Foo_(bar)", text: "Foo" },
    ]);
    expect(plainInline("snake_case_name stays, 2 * 3 * 4 stays")).toBe("snake_case_name stays, 2 * 3 * 4 stays");
  });

  it("outlines the article the way the checklist and the schema read it", () => {
    const o = outlineArticle(ARTICLE);
    expect(o.title).toBe("What is AI search visibility monitoring?");
    expect(o.lastUpdated).toBe("2026-10-07");
    expect(o.bluf.startsWith("AI search visibility monitoring tracks")).toBe(true);
    expect(o.keyFacts).toHaveLength(3);
    expect(o.tldr).toEqual(["Monitor the prompts buyers ask.", "Cite sources.", "Update quarterly."]);
    expect(o.sections.map((s) => s.heading)).toEqual(["How does it differ from SEO rank tracking?", "What does it cost?"]);
    expect(o.sections[0]!.lead).toBe(
      "Rank tracking measures positions on a results page. Visibility monitoring measures whether an answer names you at all.",
    );
    expect(o.faq).toEqual([
      { question: "Is it accurate?", answer: "Answers vary run to run, so tools sample each prompt several times." },
      { question: "Who needs it?", answer: "Teams whose buyers ask AI assistants for vendor shortlists." },
    ]);
    expect(o.sources).toHaveLength(1);
    expect(o.nextStep).not.toBeNull();
    expect(o.tableRows).toEqual([2]);
    expect(o.bodyLists).toBe(1);
    expect(o.hierarchyIssues).toEqual([]);
    expect(articleLinks(parseArticle(ARTICLE)).length).toBe(o.links.length);
    expect(o.links.map((l) => l.href)).toContain("https://acme.example/pricing");
  });

  it("finds boxes drawn as headings or bold lines, and reports heading-order problems", () => {
    const o = outlineArticle("## Key facts\n- 1 in 2\n- 3 of 4\n\n# Title\n\n#### Deep\n\n**TL;DR**\n- short\n");
    expect(o.keyFacts).toEqual(["1 in 2", "3 of 4"]);
    expect(o.tldr).toEqual(["short"]);
    expect(o.sections).toEqual([]);
    expect(o.hierarchyIssues).toEqual(["a section heading before the H1 title", 'an H4 directly under an H1 ("Deep")']);
  });

  it("exports escaped, semantic HTML with heading ids and a machine-readable date", () => {
    const html = renderArticleHtml(ARTICLE);
    expect(html).toContain("<h1>What is AI search visibility monitoring?</h1>");
    expect(html).toContain('<p class="last-updated">Last updated: <time datetime="2026-10-07">2026-10-07</time></p>');
    expect(html).toContain('<div class="callout key-facts">\n<p class="callout-label"><strong>Key facts</strong></p>');
    expect(html).toContain('<h2 id="what-does-it-cost">What does it cost?</h2>');
    expect(html).toContain('<th scope="col">Approach</th>');
    expect(html).toContain('<a href="https://acme.example/pricing">pricing</a>');
    expect(renderArticleHtml("Hello <script>alert(1)</script> & [x](javascript:alert(1))")).toBe(
      "<article>\n<p>Hello &lt;script&gt;alert(1)&lt;/script&gt; &amp; x</p>\n</article>",
    );
    // Two sections with the same heading still get distinct ids.
    expect(renderArticleHtml("## Pricing\n\n## Pricing")).toContain('<h2 id="pricing-2">');
  });

  // The other shape an article can take: an answer box under each question, "###"
  // questions inside sections, a real quotation, schema markup and a diagram as code,
  // rules between parts, a closing "Bottom line" and a call to action.
  const BOXED = [
    "# Is answer-first content working? Data and a framework",
    "",
    "Answer-first content has become a real channel. This guide sets out the **four parts** of the approach.",
    "",
    "---",
    "",
    "## What is it, and does it pay back?",
    "",
    "> **Direct Answer:** It structures a page so an answer engine can parse, trust and cite it. Teams that do it see more cited answers.",
    "",
    "---",
    "",
    "## Part 1: Facts a model can cite",
    "",
    "Models prefer dense, checkable facts.",
    "",
    "* **A named study (Example Lab):** citing sources lifted visibility by **32%**.",
    "* **First-party control:** most citations come from brand-run pages.",
    "",
    "> \"We stopped guessing which pages mattered.\" — Sam Example, Head of Content",
    "",
    "### Old way vs. new way",
    "",
    "| Factor | Old way | New way |",
    "| --- | --- | --- |",
    "| **Goal** | Rank on page one | Be cited in the answer |",
    "",
    "## Part 2: Markup",
    "",
    "Crawlers such as `ExampleBot` read structured data.",
    "",
    "```json",
    '<script type="application/ld+json">',
    '{ "@context": "https://schema.org", "@type": "Article", "wordCount": 1200 }',
    "</script>",
    "```",
    "",
    "> **Need a hand?** [Book an audit →](https://acme.example/audit)",
    "",
    "## Part 3: Questions buyers ask",
    "",
    "Turn subheadings into questions, each with a short answer.",
    "",
    "### How is it different from classic search work?",
    "",
    "> **Answer:** Classic work aims at a list of links; this aims at the answer itself.",
    "",
    "### How fast does it work?",
    "",
    "> **Answer:** Pages can be cited within **72 hours to 30 days**.",
    "",
    "## Part 4: Links that convert",
    "",
    "1. **For crawlers:** it ties the answer to the product.",
    "2. **For readers:** it turns interest into a trial.",
    "",
    "```",
    "  [Article]",
    "     ├──► [Product page]",
    "     └──► [Demo]",
    "```",
    "",
    "## The Bottom Line",
    "",
    "It works when the four parts are done together.",
    "",
    "---",
    "",
    "**Ready to start?**",
    "",
    "[See the plans →](https://acme.example/pricing) | [Read the report →](https://acme.example/report)",
  ].join("\n");

  it("parses boxes, quotations, code and rules — the whole block vocabulary", () => {
    const blocks = parseArticle(BOXED);
    const kinds = new Set(blocks.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(["callout", "code", "heading", "list", "paragraph", "rule", "table"]);
    const boxes = blocks.flatMap((b) => (b.kind === "callout" ? [b.label] : []));
    // A box has a label; the quotation has none.
    expect(boxes).toEqual(["Direct Answer", "", "Need a hand?", "Answer", "Answer"]);
    const code = blocks.flatMap((b) => (b.kind === "code" ? [b] : []));
    expect(code.map((c) => c.lang)).toEqual(["json", ""]);
    expect(code[0]!.text).toContain('<script type="application/ld+json">');
    // The diagram keeps its spacing exactly.
    expect(code[1]!.text).toBe("  [Article]\n     ├──► [Product page]\n     └──► [Demo]");
    expect(blocks.filter((b) => b.kind === "rule")).toHaveLength(3);
    expect(blocks.filter((b) => b.kind === "list").map((b) => (b.kind === "list" ? b.ordered : null))).toEqual([false, true]);
  });

  it("reads that shape: answers in boxes, questions under sections, a closing section", () => {
    const o = outlineArticle(BOXED);
    expect(o.title).toBe("Is answer-first content working? Data and a framework");
    // "The Bottom Line" closes the article; it is not a question section.
    expect(o.sections.map((s) => s.heading)).toEqual([
      "What is it, and does it pay back?",
      "Part 1: Facts a model can cite",
      "Part 2: Markup",
      "Part 3: Questions buyers ask",
      "Part 4: Links that convert",
    ]);
    expect(o.nextStep).not.toBeNull();
    // A section that opens with an Answer box answers first, without the label.
    expect(o.sections[0]!.lead).toBe(
      "It structures a page so an answer engine can parse, trust and cite it. Teams that do it see more cited answers.",
    );
    expect(o.sections[1]!.lead).toBe("Models prefer dense, checkable facts.");
    // No FAQ section → the "###" questions and the answers under them. A "###" that isn't a question is not one.
    expect(o.faq).toEqual([
      { question: "How is it different from classic search work?", answer: "Classic work aims at a list of links; this aims at the answer itself." },
      { question: "How fast does it work?", answer: "Pages can be cited within 72 hours to 30 days." },
    ]);
    expect(o.tableRows).toEqual([1]);
    // Markup in a code block is not prose: its "1200" is not a word, and not a figure to trace.
    expect(o.plain).not.toContain("wordCount");
    expect(o.links.map((l) => l.href)).toEqual([
      "https://acme.example/audit",
      "https://acme.example/pricing",
      "https://acme.example/report",
    ]);
  });

  it("exports that shape as HTML a CMS can take", () => {
    const html = renderArticleHtml(BOXED);
    expect(html).toContain('<div class="callout direct-answer">\n<p class="callout-label"><strong>Direct Answer</strong></p>\n<p>It structures');
    expect(html).toContain("<blockquote>\n<p>&quot;We stopped guessing which pages mattered.&quot; — Sam Example, Head of Content</p>\n</blockquote>");
    // A box whose bold opening is a sentence, not a label, is a plain note.
    expect(renderArticleHtml("> **Want a second pair of eyes on your markup?** [Book an audit](https://acme.example/audit)")).toContain(
      '<div class="callout note">',
    );
    expect(html).toContain('<div class="callout need-a-hand">');
    expect(html).toContain('<pre><code class="language-json">&lt;script type=&quot;application/ld+json&quot;&gt;');
    expect(html).toContain("<pre><code>  [Article]\n     ├──► [Product page]");
    expect(html).toContain("<td><strong>Goal</strong></td>");
    expect(html).toContain("<p>Crawlers such as <code>ExampleBot</code> read structured data.</p>");
    expect(html.match(/<hr>/g)).toHaveLength(3);
    expect(html).toContain('<h3 id="how-fast-does-it-work">How fast does it work?</h3>');
    // Nothing from the article becomes live markup.
    expect(html).not.toContain("<script");
  });

  it("has small text helpers", () => {
    expect(countWords("Trials grew 4x — from 550 to 2,300.")).toBe(7);
    expect(slugify("What does it cost? (2026)")).toBe("what-does-it-cost-2026");
    expect(lastUpdatedOf("*Last updated: 2026-10-07*")).toBe("2026-10-07");
    expect(lastUpdatedOf("Last updated yesterday")).toBeNull();
  });
});
