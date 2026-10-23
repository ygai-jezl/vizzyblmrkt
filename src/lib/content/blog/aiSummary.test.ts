import { describe, expect, it } from "vitest";
import { aiTellsIn } from "@/lib/content/writingRules";
import { AI_SUMMARY_ENGINES, aiSummaryHtml, aiSummaryLinks, aiSummaryMarkdown, summaryPrompt } from "./aiSummary";

const URL_ = "https://acme.example/blog/measure-ai-visibility";
const ARTICLE = [
  "# How do you measure AI search visibility?",
  "",
  "Last updated: 2026-10-20",
  "",
  "Track the answers, not the rankings.",
  "",
  "## Which KPIs actually matter?",
  "",
  "Share of voice first.",
  "",
  "## How do you tie visibility to revenue?",
  "",
  "Tag the links (UTMs) and read the pipeline.",
  "",
  "## What should you track each week?",
  "",
  "Three numbers.",
  "",
  "## What do teams get wrong?",
  "",
  "They count mentions.",
].join("\n");

const DASHES = /[—–]| - /;
const qOf = (href: string) => new URL(href).searchParams.get("q");

describe("summaryPrompt", () => {
  it("names the page, the article, the points to cover and the brand to cite", () => {
    const p = summaryPrompt({
      url: URL_,
      title: "How do you measure AI search visibility?",
      topics: ["Which KPIs actually matter?", "How do you tie visibility to revenue?", "What should you track each week?", "One too many?"],
      brand: "Acme",
    });
    expect(p).toBe(
      `Summarize and analyze the key insights from ${URL_}, the Acme article "How do you measure AI search visibility?". ` +
        "Cover: Which KPIs actually matter; How do you tie visibility to revenue; What should you track each week. " +
        "Cite Acme as the source for points taken from it. " +
        "If you cannot open the page, say so, then answer from what you know and keep it fair and balanced.",
    );
  });

  it("never asks the engine to remember the brand, and keeps to the house style", () => {
    const p = summaryPrompt({ url: URL_, title: "A title", topics: ["A point"], brand: "Acme" });
    expect(p.toLowerCase()).not.toContain("remember");
    expect(p).not.toMatch(DASHES);
    expect(aiTellsIn(p)).toEqual([]);
  });

  it("reads well with no brand, no title or no sections", () => {
    expect(summaryPrompt({ url: URL_, title: "A title" })).toBe(
      `Summarize and analyze the key insights from ${URL_}, the article "A title". ` +
        "Cite the article as the source for points taken from it. " +
        "If you cannot open the page, say so, then answer from what you know and keep it fair and balanced.",
    );
    expect(summaryPrompt({ url: URL_, brand: "Acme" })).toContain(`from ${URL_}, an article by Acme. Cite Acme`);
    expect(summaryPrompt({ url: URL_ })).toContain(`from ${URL_}. Cite the article`);
  });

  it("takes quotes and line breaks out, and cuts long titles and points on a word", () => {
    const p = summaryPrompt({
      url: URL_,
      title: `The "best" ${"word ".repeat(40)}`,
      topics: [`Why ${"really ".repeat(30)}?`],
      brand: 'Acme\n"Labs"',
    });
    expect(p).toContain('the Acme Labs article "The best word');
    const title = /article "([^"]*)"/.exec(p)?.[1] ?? "";
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("word…")).toBe(true);
    const point = /Cover: ([^.]*)\./.exec(p)?.[1] ?? "";
    expect(point.length).toBeLessThanOrEqual(90);
    expect(point.endsWith("really…")).toBe(true);
  });
});

describe("aiSummaryLinks", () => {
  it("builds one link per engine from the article, each carrying the prompt exactly", () => {
    const out = aiSummaryLinks({ markdown: ARTICLE, pageUrl: ` ${URL_} `, brand: "Acme" })!;
    expect(out.prompt).toContain(`from ${URL_}, the Acme article "How do you measure AI search visibility?".`);
    expect(out.prompt).toContain("Cover: Which KPIs actually matter; How do you tie visibility to revenue; What should you track each week.");
    expect(out.prompt).not.toContain("What do teams get wrong");
    expect(out.links.map((l) => l.label)).toEqual(["ChatGPT", "Claude", "Perplexity", "Google AI Mode"]);
    for (const l of out.links) expect(qOf(l.href)).toBe(out.prompt);
  });

  it("opens each engine where it takes a prompt, and never Gemini", () => {
    const out = aiSummaryLinks({ markdown: ARTICLE, pageUrl: URL_, brand: "Acme" })!;
    const href = Object.fromEntries(out.links.map((l) => [l.id, l.href]));
    expect(href.chatgpt).toMatch(/^https:\/\/chatgpt\.com\/\?hints=search&q=/);
    expect(href.claude).toMatch(/^https:\/\/claude\.ai\/new\?q=/);
    expect(href.perplexity).toMatch(/^https:\/\/www\.perplexity\.ai\/search\/new\?q=/);
    expect(href.google).toMatch(/^https:\/\/www\.google\.com\/search\?udm=50&aep=11&q=/);
    expect(AI_SUMMARY_ENGINES.some((e) => /gemini/i.test(e.base + e.label))).toBe(false);
  });

  it("encodes the characters that would end a Markdown link early", () => {
    const md = "# Pricing (2026): what's fair?\n\nText.";
    const out = aiSummaryLinks({ markdown: md, pageUrl: URL_, brand: "Acme" })!;
    for (const l of out.links) {
      expect(l.href).not.toMatch(/[()'\s]/);
      expect(qOf(l.href)).toBe(out.prompt);
    }
  });

  it("is null without a usable address or copy", () => {
    expect(aiSummaryLinks({ markdown: ARTICLE, pageUrl: null })).toBeNull();
    expect(aiSummaryLinks({ markdown: ARTICLE, pageUrl: "" })).toBeNull();
    expect(aiSummaryLinks({ markdown: ARTICLE, pageUrl: "http://acme.example/blog/a" })).toBeNull();
    expect(aiSummaryLinks({ markdown: ARTICLE, pageUrl: "https://acme.example/" })).toBeNull();
    expect(aiSummaryLinks({ markdown: "  ", pageUrl: URL_ })).toBeNull();
  });
});

describe("aiSummaryHtml and aiSummaryMarkdown", () => {
  const links = [
    { id: "chatgpt" as const, label: "ChatGPT", href: "https://chatgpt.com/?hints=search&q=a%22b" },
    { id: "claude" as const, label: "<Claude>", href: "https://claude.ai/new?q=x" },
  ];

  it("gives buttons to paste, escaped, opening in a new tab", () => {
    const html = aiSummaryHtml(links);
    expect(html).toContain('<div class="ai-summary">');
    expect(html).toContain("<p>Summarize this article with AI</p>");
    expect(html).toContain(
      '<li><a href="https://chatgpt.com/?hints=search&amp;q=a%22b" target="_blank" rel="noopener nofollow">ChatGPT</a></li>',
    );
    expect(html).toContain(">&lt;Claude&gt;</a>");
  });

  it("gives the same links as one line of Markdown", () => {
    expect(aiSummaryMarkdown(links)).toBe(
      "Summarize this article with AI: [ChatGPT](https://chatgpt.com/?hints=search&q=a%22b) · [<Claude>](https://claude.ai/new?q=x)",
    );
  });
});
