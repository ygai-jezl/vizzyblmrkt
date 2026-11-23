import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";

const html = (content: string) => renderToStaticMarkup(createElement(MarkdownMessage, { content }));
const count = (s: string, part: string) => s.split(part).length - 1;

// An answer shaped like the one Vizzy streamed on 22 Nov, with made-up pages and numbers: a
// sentence, a table, a closing line.
const SAMPLE_ANSWER = [
  "Two pages got clicks from Google Search in the last 28 days.",
  "",
  "| Page | Search Clicks | Impressions | Click Rate (CTR) | Average Position |",
  "| :--- | :---: | :---: | :---: | :---: |",
  "| / | 2 | 300 | 0.67% | 6.50 |",
  "| /features/example | 1 | 100 | 1.00% | 9.50 |",
  "",
  "24 Oct to 20 Nov 2026, Pacific time.",
].join("\n");

describe("MarkdownMessage tables", () => {
  it("draws a table as a table, not pipes on one line", () => {
    const out = html(SAMPLE_ANSWER);
    expect(count(out, "<table")).toBe(1);
    expect(count(out, '<th scope="col"')).toBe(5);
    expect(count(out, "<tr>")).toBe(3);
    expect(out).toContain("/features/example</td>");
    expect(out).not.toContain(":---");
    expect(out).not.toContain("| |");
    expect(out).toContain("<p>Two pages got clicks from Google Search in the last 28 days.</p>");
    expect(out).toContain("<p>24 Oct to 20 Nov 2026, Pacific time.</p>");
  });

  it("lines up columns as the separator row says", () => {
    const out = html("| Page | Clicks | Share |\n| :--- | ---: | :-: |\n| / | 12 | 50% |");
    expect(out).toMatch(/<th scope="col" class="[^"]*text-left">Page<\/th>/);
    expect(out).toMatch(/<th scope="col" class="[^"]*text-right">Clicks<\/th>/);
    expect(out).toMatch(/<td class="[^"]*text-center">50%<\/td>/);
    // No colon at all reads left, as GitHub shows it.
    expect(html("| a | b |\n| --- | --- |\n| 1 | 2 |")).toMatch(/<td class="[^"]*text-left">2<\/td>/);
  });

  it("starts a table straight after a sentence, and keeps the sentence its own paragraph", () => {
    const out = html("Here are the pages:\n| Page | Clicks |\n| --- | --- |\n| /pricing | 4 |\nThat's all of them.");
    expect(out).toContain("<p>Here are the pages:</p>");
    expect(count(out, "<table")).toBe(1);
    expect(out).toContain("/pricing</td>");
    // A line with no pipe ends the table and starts a paragraph.
    expect(out).toContain("<p>That&#x27;s all of them.</p>");
  });

  it("keeps a header row whose separator hasn't streamed in yet as a paragraph, without throwing", () => {
    for (const partial of [
      "Here you go:\n\n| Page | Clicks | Impressions |",
      "Here you go:\n\n| Page | Clicks | Impressions |\n",
      "Here you go:\n\n| Page | Clicks | Impressions |\n| :--",
      "Here you go:\n\n| Page | Clicks | Impressions |\n| :--- | :---: |",
    ]) {
      const out = html(partial);
      expect(out).not.toContain("<table");
      expect(out).toContain("| Page | Clicks | Impressions |");
    }
    // Once the separator arrives, the half written row is padded to the header's width.
    const out = html("| Page | Clicks | Impressions |\n| :--- | :---: | :---: |\n| / | 1");
    expect(count(out, "<td")).toBe(3);
  });

  it("is not a table when the separator has a different number of cells, or is a lone rule", () => {
    expect(html("| a | b | c |\n| --- | --- |\n| 1 | 2 | 3 |")).not.toContain("<table");
    expect(html("Costs | more\n---")).not.toContain("<table");
    expect(html("one | column\n| --- |")).not.toContain("<table");
  });

  it("keeps an escaped pipe as a literal pipe in its cell", () => {
    const out = html("| Query | Clicks |\n| --- | --- |\n| a \\| b | 3 |");
    expect(count(out, "<td")).toBe(2);
    expect(out).toContain(">a | b</td>");
  });

  it("renders cells inline like a paragraph, with raw HTML inert and only safe links", () => {
    const out = html(
      [
        "| Page | Note |",
        "| --- | --- |",
        "| **/pricing** | `utm_source` |",
        "| <script>alert(1)</script> | <img src=x onerror=alert(1)> |",
        "| [bad](javascript:alert(1)) | [off](//evil.example/x) |",
        "| [docs](https://example.com/docs) | [page](/admin/account/connections/connected) |",
      ].join("\n"),
    );
    expect(out).toContain("<strong>/pricing</strong>");
    expect(out).toContain(">utm_source</code>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain('href="javascript:');
    expect(out).not.toContain('href="//evil.example');
    expect(out).toContain('href="https://example.com/docs"');
    expect(out).toContain('href="/admin/account/connections/connected"');
  });

  it("pads short rows and cuts long ones to the header's width", () => {
    const out = html("| a | b | c |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |");
    expect(count(out, "<td")).toBe(6);
    expect(out).not.toContain(">4</td>");
  });

  it("scrolls a wide table sideways inside its own box, in light and dark", () => {
    const out = html("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toMatch(/<div class="overflow-x-auto [^"]*dark:border-neutral-700"><table/);
    expect(out).toContain("dark:bg-neutral-800/60");
    expect(out).toContain("dark:divide-neutral-700");
  });

  it("reads a table between other blocks", () => {
    const out = html("## Pages\n| a | b |\n| --- | --- |\n| 1 | 2 |\n- next\n\n```\n| x | y |\n| - | - |\n```");
    expect(out).toContain('<p class="text-sm font-semibold">Pages</p>');
    expect(count(out, "<table")).toBe(1);
    expect(out).toContain("<li>next</li>");
    // A table inside a code fence stays code.
    expect(out).toContain("<code>| x | y |\n| - | - |</code>");
  });
});

// What these messages rendered as before tables existed, captured from the old renderer.
const BEFORE: Record<string, { content: string; html: string }> = {
  mixed: {
    content: "# Launch check\nYour **waitlist** grew by 12 this week, see [the launch](/admin/launches/l1) or [docs](https://example.com/docs).\nA second line of the same paragraph with `code`.\n\n## Next steps\n- Send the welcome email\n* Check the `utm_source` split\n\n1. Open Launches\n2. Pick **Beta**\n\n### Notes\n```\nconst x = 1;\n<b>not bold</b>\n```\n\nRaw <script>alert(1)</script> stays text, and [bad](javascript:alert(1)) is not a link.\nA line | with a pipe stays in its paragraph.",
    html: "<div class=\"space-y-2 text-sm leading-relaxed\"><p class=\"text-base font-semibold\">Launch check</p><p>Your <strong>waitlist</strong> grew by 12 this week, see <a href=\"/admin/launches/l1\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400\">the launch</a> or <a href=\"https://example.com/docs\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400\">docs</a>. A second line of the same paragraph with <code class=\"rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800\">code</code>.</p><p class=\"text-sm font-semibold\">Next steps</p><ul class=\"list-disc space-y-1 pl-5\"><li>Send the welcome email</li><li>Check the <code class=\"rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800\">utm_source</code> split</li></ul><ol class=\"list-decimal space-y-1 pl-5\"><li>Open Launches</li><li>Pick <strong>Beta</strong></li></ol><p class=\"text-sm font-medium\">Notes</p><pre class=\"overflow-x-auto rounded-md bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-900\"><code>const x = 1;\n&lt;b&gt;not bold&lt;/b&gt;</code></pre><p>Raw &lt;script&gt;alert(1)&lt;/script&gt; stays text, and [bad](javascript:alert(1)) is not a link. A line | with a pipe stays in its paragraph.</p></div>",
  },
  crlf: {
    content: "First line\r\nSecond line\r\n\r\n- item",
    html: "<div class=\"space-y-2 text-sm leading-relaxed\"><p>First line Second line</p><ul class=\"list-disc space-y-1 pl-5\"><li>item</li></ul></div>",
  },
  unclosed: {
    content: "Before\n```\ncode never closed",
    html: "<div class=\"space-y-2 text-sm leading-relaxed\"><p>Before</p><pre class=\"overflow-x-auto rounded-md bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-900\"><code>code never closed</code></pre></div>",
  },
};

describe("MarkdownMessage older messages", () => {
  it.each(Object.entries(BEFORE))("renders %s exactly as before", (_, shape) => {
    expect(html(shape.content)).toBe(shape.html);
  });

  it("leaves a sentence holding a pipe in its paragraph", () => {
    expect(html("Clicks | impressions are both up.")).toBe('<div class="space-y-2 text-sm leading-relaxed"><p>Clicks | impressions are both up.</p></div>');
  });
});
