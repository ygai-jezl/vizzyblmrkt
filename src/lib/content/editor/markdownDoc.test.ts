import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import { parseArticle } from "@/lib/content/blog/markdown";
import { evaluateCitable } from "@/lib/content/blog/citable";
import { BlogArticleMetaSchema } from "@/lib/types/contentPlan";
import { editorExtensions } from "./extensions";
import { docLoss, docToMarkdown, markdownEditProblem, markdownToDoc } from "./markdownDoc";

const CITABLE = `# What is AI search visibility monitoring?

*Last updated: 2026-10-07*

AI search visibility monitoring tracks how often a brand is named in AI answers. It is for B2B marketing teams. Use it when buyers research vendors in ChatGPT.

> **Key facts**
> - 40% of B2B buyers use AI assistants for vendor research [Example Research, 2026](https://research.example.com/report)
> - Acme tracks 8 answer engines [Acme](https://acme.example/product)

> **TL;DR**
> - Monitor the prompts buyers ask.
> - Cite sources.

## How does it differ from SEO rank tracking?

Rank tracking measures **positions** on a results page. Visibility monitoring measures whether an *answer* names you at all.

| Approach | Measures |
| --- | --- |
| Rank tracking | Position |
| Visibility monitoring | Mentions \\| citations |

- One
- Two

## What does it cost?

Plans start low. See [pricing](https://acme.example/pricing) or the [FAQ](#frequently-asked-questions).

## Frequently asked questions

### Is it accurate?

Answers vary run to run, so tools sample each prompt several times.

## Sources

1. [AI search report](https://research.example.com/report), Example Research, 2026
2. [Acme product page](/product)
`;

const EDITORIAL = `# How often should marketing teams check their AI answers?

*Last updated: 2026-10-18 · By Ana Ruiz, Head of Growth*

Most teams check too rarely. A monthly look misses the week a rival's launch rewrote the answers.

> "We only noticed when a customer quoted a rival's claim back to us."

## What changes between two checks?

The answer engines retrain, sources move, and a new article can take your place.

\`\`\`json
{ "@context": "https://schema.org", "@type": "Article" }
\`\`\`

---

## About the author

**Ana Ruiz**, Head of Growth

Ana runs growth at [Acme](https://acme.example).
`;

const schema = getSchema(editorExtensions("blog"));

function roundTrip(md: string, format: "blog" | "newsletter" = "blog"): string {
  return docToMarkdown(markdownToDoc(md, format));
}

describe("markdownToDoc", () => {
  it("turns every block kind into the editor's nodes", () => {
    const doc = markdownToDoc(CITABLE, "blog");
    const types = (doc.content ?? []).map((n) => n.type);
    expect(types).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "articleBox",
      "articleBox",
      "heading",
      "paragraph",
      "table",
      "bulletList",
      "heading",
      "paragraph",
      "heading",
      "heading",
      "paragraph",
      "heading",
      "orderedList",
    ]);
    const box = doc.content?.[3];
    expect(box?.attrs).toEqual({ label: "Key facts" });
    expect(box?.content?.[0]?.type).toBe("bulletList");
  });

  it("gives a quotation, code with its language, and a rule", () => {
    const doc = markdownToDoc(EDITORIAL, "blog");
    const types = (doc.content ?? []).map((n) => n.type);
    expect(types).toContain("blockquote");
    expect(types).toContain("horizontalRule");
    const code = doc.content?.find((n) => n.type === "codeBlock");
    expect(code?.attrs).toEqual({ language: "json" });
    expect(code?.content?.[0]?.text).toBe('{ "@context": "https://schema.org", "@type": "Article" }');
  });

  it("carries bold, italic, code and links as marks", () => {
    const doc = markdownToDoc("A **bold** and *italic* word, `code`, a [link](https://example.com) and **[both](/x)**.", "blog");
    const runs = doc.content?.[0]?.content ?? [];
    const marksOf = (text: string) => runs.find((r) => r.text === text)?.marks?.map((m) => m.type);
    expect(marksOf("bold")).toEqual(["bold"]);
    expect(marksOf("italic")).toEqual(["italic"]);
    expect(marksOf("code")).toEqual(["code"]);
    expect(marksOf("link")).toEqual(["link"]);
    expect(marksOf("both")).toEqual(["bold", "link"]);
  });

  it("builds the email schema too", () => {
    expect(() => getSchema(editorExtensions("email"))).not.toThrow();
  });

  it("fits the editor's schema", () => {
    for (const md of [CITABLE, EDITORIAL, "", "Just one line."]) {
      expect(() => schema.nodeFromJSON(markdownToDoc(md, "blog")).check()).not.toThrow();
    }
  });

  it("keeps a merge value link in a newsletter, not in a blog", () => {
    const md = "[Read the article]({{hub_url}})";
    const link = (format: "blog" | "newsletter") =>
      markdownToDoc(md, format).content?.[0]?.content?.[0]?.marks?.find((m) => m.type === "link");
    expect(link("newsletter")?.attrs).toEqual({ href: "{{hub_url}}" });
    expect(link("blog")).toBeUndefined();
  });
});

describe("docToMarkdown", () => {
  it("reads back as the same article", () => {
    for (const md of [CITABLE, EDITORIAL]) {
      // The same document, mark for mark, whatever spelling the Markdown used.
      expect(markdownToDoc(roundTrip(md), "blog")).toEqual(markdownToDoc(md, "blog"));
      expect(markdownEditProblem(md, "blog")).toBeNull();
    }
  });

  it("is stable on a second pass", () => {
    for (const md of [CITABLE, EDITORIAL]) {
      const once = roundTrip(md);
      expect(roundTrip(once)).toBe(once);
    }
  });

  it("writes the shapes the writer uses", () => {
    const out = roundTrip(CITABLE);
    expect(out).toContain("*Last updated: 2026-10-07*");
    expect(out).toContain("> **Key facts**\n>\n> - 40% of B2B buyers");
    expect(out).toContain("| Visibility monitoring | Mentions \\| citations |");
    expect(out).toContain("1. [AI search report](https://research.example.com/report), Example Research, 2026");
    expect(roundTrip(EDITORIAL)).toContain('```json\n{ "@context"');
  });

  it("scores the same on the CITABLE and editorial checklists", () => {
    const statuses = (md: string, ctx = {}) => evaluateCitable(md, ctx).items.map((i) => [i.id, i.status]);
    expect(statuses(roundTrip(CITABLE))).toEqual(statuses(CITABLE));
    const meta = BlogArticleMetaSchema.parse({ style: "editorial" });
    expect(statuses(roundTrip(EDITORIAL), { meta })).toEqual(statuses(EDITORIAL, { meta }));
  });

  it("escapes text that would otherwise read as formatting", () => {
    const cases = [
      "2 * 3 = 6, and *stars* typed by hand",
      "snake_case stays, but _this_ is literal",
      "A `tick` typed as text",
      "Brackets [like this](not a link) and [Author name]",
      "A back\\slash and a \\* pair",
    ];
    for (const text of cases) {
      const doc: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
      const md = docToMarkdown(doc);
      const back = markdownToDoc(md, "blog").content?.[0]?.content ?? [];
      expect(back).toEqual([{ type: "text", text }]);
    }
    const snake: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "snake_case" }] }] };
    expect(docToMarkdown(snake)).toBe("snake_case");
    expect(docToMarkdown(snake)).not.toContain("\\");
  });

  it("guards a paragraph that starts like a heading, list, quote or rule", () => {
    for (const text of ["# not a heading", "- not a list", "1. not a list", "> not a quote", "---", "+ plus"]) {
      const doc: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
      const back = markdownToDoc(docToMarkdown(doc), "blog");
      expect(back.content?.[0]).toEqual({ type: "paragraph", content: [{ type: "text", text }] });
    }
  });

  it("keeps a heading's own # and a cell's pipe", () => {
    const md = "## Why C# matters\n\n| Pipe | Kept |\n| --- | --- |\n| a \\| b | `x\\|y` |";
    expect(markdownToDoc(roundTrip(md), "blog")).toEqual(markdownToDoc(md, "blog"));
    expect(parseArticle(md)[1]).toMatchObject({ rows: [["a | b", "`x|y`"]] });
    expect(parseArticle(md)[0]).toEqual({ kind: "heading", level: 2, text: "Why C# matters" });
  });

  it("writes bold and italic together so both read back", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "both", marks: [{ type: "bold" }, { type: "italic" }] },
            { type: "text", text: " then " },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
          ],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe("**_both_** then **bold**_italic_");
    expect(docLoss(doc, "blog")).toBeNull();
  });

  it("drops empty paragraphs and empty list items, which Markdown can't hold", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Kept" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] },
      ],
    };
    expect(docToMarkdown(doc)).toBe("Kept");
    expect(docLoss(doc, "blog")).toBeNull();
  });

  it("writes a box with no label as a quotation", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "articleBox", attrs: { label: "" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Said once" }] }] }],
    };
    expect(docToMarkdown(doc)).toBe("> Said once");
  });

  it("adds a new table, row and box the way the toolbar builds them", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "articleBox",
          attrs: { label: "TL;DR" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "The answer in a line." }] }],
        },
        {
          type: "table",
          content: [
            { type: "tableRow", content: ["Step", "Where"].map((t) => ({ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
            { type: "tableRow", content: ["Sign-up page", ""].map((t) => ({ type: "tableCell", content: [t ? { type: "paragraph", content: [{ type: "text", text: t }] } : { type: "paragraph" }] })) },
          ],
        },
      ],
    };
    const md = docToMarkdown(doc);
    expect(md).toBe("> **TL;DR**\n>\n> The answer in a line.\n\n| Step | Where |\n| --- | --- |\n| Sign-up page | |");
    expect(parseArticle(md)[0]).toMatchObject({ kind: "callout", label: "TL;DR" });
    expect(docLoss(doc, "blog")).toBeNull();
  });
});

describe("docLoss", () => {
  it("names formatting Markdown can't keep, under its heading", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Pricing" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "un" },
            { type: "text", text: "believ", marks: [{ type: "italic" }] },
            { type: "text", text: "able" },
          ],
        },
      ],
    };
    expect(docLoss(doc, "blog")).toEqual({ kind: "paragraph", near: "Pricing", under: true });
  });

  it("names a nested list, which is flattened", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
                { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Child" }] }] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe("- Parent\n- Child");
    expect(docLoss(doc, "blog")).toEqual({ kind: "list", near: "Parent Child", under: false });
  });

  it("names a one column table, which Markdown can't hold", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Only" }] }] }] },
          ],
        },
      ],
    };
    expect(docLoss(doc, "blog")?.kind).toBe("table");
  });
});
