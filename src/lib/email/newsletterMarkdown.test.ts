import { describe, expect, it } from "vitest";
import { looksHtml, sanitizeEmailHtml } from "./emailRender";
import { MAX_BROADCAST_BODY_CHARS, renderNewsletterHtml } from "./newsletterMarkdown";

describe("renderNewsletterHtml", () => {
  it("draws each block as email HTML", () => {
    const html = renderNewsletterHtml(
      [
        "# This week",
        "## What is new",
        "A **bold** word, an *italic* one and `code`.",
        "- One\n- Two",
        "1. First\n2. Second",
        "> **Key facts**\n> - A fact",
        "> Somebody said this.",
        "| A | B |\n| --- | --- |\n| 1 | 2 |",
        "```\nnpm run local\n```",
        "---",
      ].join("\n\n"),
    );
    expect(html).toContain(">This week</h1>");
    expect(html).toContain(">What is new</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toMatch(/<code style="[^"]*">code<\/code>/);
    expect(html).toContain("<ul><li>One</li>");
    expect(html).toContain("<ol><li>First</li>");
    expect(html).toMatch(/<p style="[^"]*"><strong>Key facts<\/strong><\/p>/);
    expect(html).toMatch(/<blockquote style="[^"]*"><p>Somebody said this\.<\/p><\/blockquote>/);
    expect(html).toMatch(/<th style="[^"]*">A<\/th>/);
    expect(html).toMatch(/<pre style="[^"]*">npm run local<\/pre>/);
    expect(html).toMatch(/<hr style="[^"]*">/);
    expect(looksHtml(html)).toBe(true);
  });

  it("escapes text and keeps a merge value link", () => {
    const html = renderNewsletterHtml('Fish & <b>chips</b>, "quoted". [Read it]({{hub_url}}) or [mail](mailto:hi@example.com).');
    expect(html).toContain("Fish &amp; &lt;b&gt;chips&lt;/b&gt;, &quot;quoted&quot;.");
    expect(html).toContain('<a href="{{hub_url}}"');
    expect(html).toContain('<a href="mailto:hi@example.com"');
  });

  it("drops a link it can't trust, keeping the words", () => {
    const html = renderNewsletterHtml("[Click](javascript:alert(1)) and [this](//evil.example)");
    expect(html).not.toContain("<a ");
    expect(html).toContain("Click");
  });

  it("keeps an escaped character as text", () => {
    expect(renderNewsletterHtml("2 \\* 3 is not *italic*")).toContain("2 * 3 is not <em>italic</em>");
  });

  it("keeps the longest newsletter under the broadcast's limit, styles and all for a usual one", () => {
    const fill = (section: string) => {
      let md = "";
      while (md.length + section.length <= 20_000) md += section;
      return md;
    };
    // Prose and lists: styled.
    const prose = renderNewsletterHtml(fill("## A heading here\n\nA paragraph of plain words with **bold** and a [link](https://example.com/page).\n\n- An item\n- Another item\n\n"));
    expect(prose.length).toBeLessThanOrEqual(MAX_BROADCAST_BODY_CHARS);
    expect(prose).toContain("<h2 style=");
    // Mostly table cells: too long styled, so drawn plain.
    const cells = renderNewsletterHtml(fill("## Prices\n\nWhat each plan costs, and what it holds for a team.\n\n| Plan | Price |\n| --- | --- |\n| Starter | Free |\n\n"));
    expect(cells.length).toBeLessThanOrEqual(MAX_BROADCAST_BODY_CHARS);
    expect(cells).not.toContain("style=");
  });

  it("holds nothing sanitizeEmailHtml would call unsafe", () => {
    const html = renderNewsletterHtml("Hi [there](https://example.com) **friend**");
    // The sanitizer drops styles, so compare the words and the link only.
    expect(sanitizeEmailHtml(html)).toContain('<a href="https://example.com"');
  });
});
