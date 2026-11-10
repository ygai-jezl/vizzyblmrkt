import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { editorExtensions } from "./extensions";
import { markdownToDoc } from "./markdownDoc";
import { textblocksOf } from "./vizzyAnchor";
import { markdownSerializer, selectionTarget } from "./vizzySelection";

const schema = getSchema(editorExtensions("blog"));

function stateWith(md: string, from: string, to?: string): EditorState {
  const doc = schema.nodeFromJSON(markdownToDoc(md, "blog"));
  const find = (words: string, end: boolean) => {
    for (const b of textblocksOf(doc)) {
      const at = b.text.indexOf(words);
      if (at >= 0) return b.pos + 1 + at + (end ? words.length : 0);
    }
    throw new Error(`no "${words}"`);
  };
  const a = find(from, false);
  const b = to === undefined ? find(from, true) : find(to, true);
  return EditorState.create({ schema, doc, selection: TextSelection.create(doc, a, b) });
}

const ARTICLE = [
  "# Plan a launch",
  "",
  "Most teams **lose a week** to [the checklist](/guide), then rush.",
  "",
  "## Week 1",
  "",
  "Start a waitlist page. Share it with people who know you.",
  "",
  "| Step | Owner |",
  "| --- | --- |",
  "| Build the page | Sam |",
  "",
  "```js",
  "const a = 1;",
  "```",
].join("\n");

describe("what a selection asks Vizzy to change", () => {
  it("sends part of a paragraph as inline Markdown, keeping marks and links", () => {
    const t = selectionTarget(stateWith(ARTICLE, "lose a week to the"), markdownSerializer);
    expect(t).toMatchObject({ shape: "inline", text: "**lose a week** to [the](/guide)", plain: "lose a week to the" });
  });

  it("widens a selection to whole words and trims its spaces", () => {
    const state = stateWith(ARTICLE, "aitlist page");
    const t = selectionTarget(state, markdownSerializer);
    expect(t).toMatchObject({ shape: "inline", plain: "waitlist page" });
  });

  it("sends the words around it, from the same paragraph and the blocks either side", () => {
    const t = selectionTarget(stateWith(ARTICLE, "Share it with people who know you."), markdownSerializer);
    if ("error" in t) throw new Error(t.error);
    expect(t.before.trimEnd().endsWith("## Week 1\n\nStart a waitlist page.")).toBe(true);
    expect(t.after.startsWith("| Step | Owner |")).toBe(true);
  });

  it("escapes a pipe in a table cell", () => {
    const md = "| A | B |\n| --- | --- |\n| x \\| y | z |";
    const t = selectionTarget(stateWith(md, "x | y"), markdownSerializer);
    expect(t).toMatchObject({ shape: "inline", text: "x \\| y" });
  });

  it("widens a selection across blocks to whole blocks", () => {
    const t = selectionTarget(stateWith(ARTICLE, "Week 1", "Start a waitlist"), markdownSerializer);
    expect(t).toMatchObject({
      shape: "blocks",
      text: "## Week 1\n\nStart a waitlist page. Share it with people who know you.",
    });
  });

  it("refuses code, and an empty selection", () => {
    expect(selectionTarget(stateWith(ARTICLE, "const a"), markdownSerializer)).toEqual({
      error: "Vizzy doesn't change code. Select text outside the code block.",
    });
    expect(selectionTarget(stateWith(ARTICLE, "Build the page", "const a"), markdownSerializer)).toMatchObject({
      error: expect.stringContaining("code"),
    });
    const empty = EditorState.create({ schema, doc: schema.nodeFromJSON(markdownToDoc(ARTICLE, "blog")) });
    expect(selectionTarget(empty, markdownSerializer)).toEqual({ error: "Select some text first." });
  });
});
