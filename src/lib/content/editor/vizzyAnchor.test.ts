import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { editorExtensions } from "./extensions";
import { markdownToDoc } from "./markdownDoc";
import { anchorText, findAnchor, findWords, matchCase, textblocksOf } from "./vizzyAnchor";

const schema = getSchema(editorExtensions("blog"));
const docOf = (md: string) => schema.nodeFromJSON(markdownToDoc(md, "blog"));

const ARTICLE = [
  "# Plan a launch",
  "",
  "Most teams **lose a week** to [the checklist](/guide), then rush.",
  "",
  "## Week 1: build the list",
  "",
  "- Organize the list by source.",
  "- Keep the color the same.",
  "",
  "| Step | Owner |",
  "| --- | --- |",
  "| Organize | Sam |",
  "",
  "```js",
  "const color = 1;",
  "```",
].join("\n");

describe("finding the words an edit is for", () => {
  const doc = docOf(ARTICLE);
  const blocks = textblocksOf(doc);

  it("finds words across bold and links, at the right positions", () => {
    const hit = findAnchor(blocks, anchorText("lose a week to the checklist", "blog"));
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(doc.textBetween(hit.from, hit.to)).toBe("lose a week to the checklist");
  });

  it("reads Markdown in the anchor as the words it shows", () => {
    expect(anchorText("**lose a week** to [the checklist](/guide)", "blog")).toBe("lose a week to the checklist");
    expect(anchorText("## Week 1: build the list", "blog")).toBe("Week 1: build the list");
    expect(anchorText("- Keep the color the same.", "blog")).toBe("Keep the color the same.");
    expect(anchorText("<strong>Hi</strong> &amp; bye", "email")).toBe("Hi & bye");
    expect(anchorText("two\nlines", "blog")).toBeNull();
  });

  it("says why when the words aren't there exactly once outside code", () => {
    expect(findAnchor(blocks, "Organize")).toEqual({ ok: false, reason: "ambiguous" });
    expect(findAnchor(blocks, "not in the text")).toEqual({ ok: false, reason: "not_found" });
    expect(findAnchor(blocks, "const color = 1;")).toEqual({ ok: false, reason: "in_code" });
    expect(findAnchor(blocks, null)).toEqual({ ok: false, reason: "spans_blocks" });
  });

  it("matches curly and straight quotes alike", () => {
    const d = docOf("It’s here and that’s it.");
    const hit = findAnchor(textblocksOf(d), "It's here");
    expect(hit.ok && d.textBetween(hit.from, hit.to)).toBe("It’s here");
  });

  it("finds a word everywhere as a whole word, any case, never in code", () => {
    const found = findWords(blocks, "organize", 50);
    expect(found.map((f) => f.text)).toEqual(["Organize", "Organize"]);
    for (const f of found) expect(doc.textBetween(f.from, f.to)).toBe("Organize");
    expect(findWords(blocks, "color", 50)).toHaveLength(1);
    expect(findWords(textblocksOf(docOf("colorful color")), "color", 50).map((f) => f.from)).toEqual([10]);
    expect(findWords(blocks, "organize", 1)).toHaveLength(1);
  });

  it("keeps the case of the word it replaces", () => {
    expect(matchCase("Organize", "organise")).toBe("Organise");
    expect(matchCase("ORGANIZE", "organise")).toBe("ORGANISE");
    expect(matchCase("organize", "organise")).toBe("organise");
  });
});

describe("email documents", () => {
  const email = getSchema(editorExtensions("email"));

  it("keeps offsets right after a line break", () => {
    const d = email.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hi there," }, { type: "hardBreak" }, { type: "text", text: "Your list is ready." }] }],
    });
    const hit = findAnchor(textblocksOf(d), "list is ready");
    expect(hit.ok && d.textBetween(hit.from, hit.to)).toBe("list is ready");
  });
});
