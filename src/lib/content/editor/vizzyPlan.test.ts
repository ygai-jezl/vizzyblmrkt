import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { editorExtensions } from "./extensions";
import { docToMarkdown, markdownToDoc } from "./markdownDoc";
import { textblocksOf } from "./vizzyAnchor";
import { markdownFragments, planSelectionEdit, planWholeEdits } from "./vizzyPlan";
import { applyEditsTr, vizzyPlugin } from "./vizzyPlugin";
import { markdownSerializer, selectionTarget, type VizzyTarget } from "./vizzySelection";
import type { WholeOp } from "./vizzyOps";

const schema = getSchema(editorExtensions("blog"));
const make = markdownFragments(schema, "blog");
const base = { format: "blog" as const, make, ser: markdownSerializer, instruction: "tidy" };

function stateOf(md: string): EditorState {
  return EditorState.create({ schema, doc: schema.nodeFromJSON(markdownToDoc(md, "blog")), plugins: [vizzyPlugin()] });
}

function select(state: EditorState, words: string): EditorState {
  for (const b of textblocksOf(state.doc)) {
    const at = b.text.indexOf(words);
    if (at >= 0) return state.apply(state.tr.setSelection(TextSelection.create(state.doc, b.pos + 1 + at, b.pos + 1 + at + words.length)));
  }
  throw new Error(`no "${words}"`);
}

const markdownOf = (state: EditorState) => docToMarkdown(state.doc.toJSON() as JSONContent);

const ARTICLE = [
  "# Plan a launch",
  "",
  "Most launches slip because the team tries to do everything at once, and in today's world that is a mistake.",
  "",
  "Read [the guide](/guide) first. It is **very good indeed**.",
  "",
  "## Week 1",
  "",
  "- Organize the list.",
  "- Pick a color.",
  "",
  "Keep the color the same. Then organize the page.",
].join("\n");

describe("a selection's replacement", () => {
  const target = (state: EditorState) => selectionTarget(state, markdownSerializer) as VizzyTarget;

  it("replaces just the selected words", () => {
    const state = select(stateOf(ARTICLE), ", and in today's world that is a mistake");
    const t = target(state);
    const planned = planSelectionEdit({ ...base, state, target: t, replacement: "", warnings: [] });
    if ("error" in planned) throw new Error(planned.error);
    const next = state.apply(applyEditsTr(state, [planned.edit], { group: "g", instruction: "shorter", requestKind: "selection" }));
    expect(markdownOf(next)).toContain("Most launches slip because the team tries to do everything at once.\n\nRead");
  });

  it("refuses when the text changed while Vizzy worked", () => {
    const state = select(stateOf(ARTICLE), "Most launches slip");
    const t = target(state);
    const typed = state.apply(state.tr.insertText("Often ", t.from));
    expect(planSelectionEdit({ ...base, state: typed, target: t, replacement: "Launches slip", warnings: [] })).toEqual({
      error: "The text changed while Vizzy was working. Ask again.",
    });
  });

  it("refuses a version that drops a link or runs to two paragraphs", () => {
    const state = select(stateOf(ARTICLE), "Read the guide first.");
    const t = target(state);
    expect(planSelectionEdit({ ...base, state, target: t, replacement: "Read the guide first.", warnings: [] })).toMatchObject({
      error: expect.stringContaining("dropped the link to /guide"),
    });
    expect(planSelectionEdit({ ...base, state, target: t, replacement: "One.\n\nTwo [link](/guide).", warnings: [] })).toMatchObject({
      error: expect.stringContaining("more than one paragraph"),
    });
  });

  it("keeps the warnings from the route and adds its own", () => {
    const state = select(stateOf(ARTICLE), "Most launches slip");
    const planned = planSelectionEdit({ ...base, state, target: target(state), replacement: "Launches slip seamlessly", warnings: ["From the route."] });
    expect("edit" in planned && planned.edit.warnings).toEqual(["From the route.", 'It uses "seamlessly", which reads as AI writing.']);
  });
});

describe("edits across the whole piece", () => {
  const plan = (ops: WholeOp[], state = stateOf(ARTICLE)) =>
    planWholeEdits({ ...base, state, ops: ops.map((op) => ({ op, warnings: [] })) });

  it("changes a word everywhere, keeping its case, and leaves code alone", () => {
    const state = stateOf(`${ARTICLE}\n\n\`\`\`js\nconst color = 1;\n\`\`\``);
    const { edits, skipped } = plan([{ op: "replace_all", find: "organize", replace: "organise" }, { op: "replace_all", find: "color", replace: "colour" }], state);
    expect(skipped).toEqual([]);
    expect(edits).toHaveLength(4);
    const next = state.apply(applyEditsTr(state, edits, { group: "g", instruction: "UK spelling", requestKind: "whole" }));
    const md = markdownOf(next);
    expect(md).toContain("- Organise the list.\n- Pick a colour.");
    expect(md).toContain("Keep the colour the same. Then organise the page.");
    expect(md).toContain("const color = 1;");
  });

  it("keeps bold when a word inside bold text changes", () => {
    const state = stateOf(ARTICLE);
    const { edits } = plan([{ op: "replace", find: "very good indeed", replace: "good" }], state);
    const next = state.apply(applyEditsTr(state, edits, { group: "g", instruction: "plainer", requestKind: "whole" }));
    expect(markdownOf(next)).toContain("It is **good**.");
  });

  it("adds an item to a list, and a paragraph after a paragraph", () => {
    const state = stateOf(ARTICLE);
    const { edits, skipped } = plan(
      [
        { op: "insert_after", after: "Pick a color.", insert: "- Book the date." },
        { op: "insert_after", after: "It is very good indeed.", insert: "Start with the checklist." },
      ],
      state,
    );
    expect(skipped).toEqual([]);
    const next = state.apply(applyEditsTr(state, edits, { group: "g", instruction: "add", requestKind: "whole" }));
    const md = markdownOf(next);
    expect(md).toContain("- Organize the list.\n- Pick a color.\n- Book the date.");
    expect(md).toContain("It is **very good indeed**.\n\nStart with the checklist.\n\n## Week 1");
  });

  it("skips what it can't place exactly, overlaps, and lost links, saying why", () => {
    const { edits, skipped } = plan([
      { op: "replace", find: "color", replace: "colour" },
      { op: "replace", find: "Most launches slip", replace: "Launches slip" },
      { op: "replace", find: "launches slip because", replace: "launches fail because" },
      { op: "replace", find: "Read the guide first", replace: "Read it first" },
    ]);
    expect(edits.map((e) => e.afterText)).toEqual(["Launches slip"]);
    expect(skipped.map((s) => s.reason)).toEqual([
      "Those words appear more than once, so nothing changed there.",
      "Vizzy's version dropped the link to /guide, so it wasn't used.",
      "It overlaps another change, so nothing changed there.",
    ]);
  });

  it("doesn't touch a change still waiting to be kept or undone", () => {
    const state = stateOf(ARTICLE);
    const hit = textblocksOf(state.doc).find((b) => b.text.startsWith("Keep the color"))!;
    const pending = [{ from: hit.pos + 1, to: hit.pos + 10 }];
    const { edits, skipped } = planWholeEdits({
      ...base,
      state,
      pending,
      ops: [{ op: { op: "replace", find: "Keep the color the same", replace: "Keep one colour" }, warnings: [] }],
    });
    expect(edits).toEqual([]);
    expect(skipped[0]?.reason).toBe("It overlaps another change, so nothing changed there.");
  });
});
