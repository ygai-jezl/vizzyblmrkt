import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { Fragment } from "@tiptap/pm/model";
import { editorExtensions } from "./extensions";
import { markdownToDoc } from "./markdownDoc";
import { textblocksOf } from "./vizzyAnchor";
import type { PlannedEdit } from "./vizzyPlan";
import {
  applyEditsTr,
  clearSuggestionsTr,
  keepSuggestionsTr,
  setTargetTr,
  undoSuggestionsTr,
  vizzyPending,
  vizzyPlugin,
  vizzyResolved,
  vizzyTarget,
} from "./vizzyPlugin";

const schema = getSchema(editorExtensions("blog"));
const START = "First line here.\n\nSecond line stays.\n\nThird line is long.";

function fresh(): EditorState {
  return EditorState.create({ schema, doc: schema.nodeFromJSON(markdownToDoc(START, "blog")), plugins: [history(), vizzyPlugin()] });
}

function range(state: EditorState, words: string): { from: number; to: number } {
  for (const b of textblocksOf(state.doc)) {
    const at = b.text.indexOf(words);
    if (at >= 0) return { from: b.pos + 1 + at, to: b.pos + 1 + at + words.length };
  }
  throw new Error(`no "${words}"`);
}

function edit(state: EditorState, words: string, text: string): PlannedEdit {
  const r = range(state, words);
  return {
    ...r,
    content: text ? Fragment.from(schema.text(text)) : Fragment.empty,
    kind: "inline",
    beforeText: words,
    afterText: text,
    warnings: [],
  };
}

let n = 0;
const info = { group: "g1", instruction: "shorter", requestKind: "selection" as const, makeId: () => `s${(n += 1)}` };

function applyVizzy(state: EditorState, edits: PlannedEdit[]): EditorState {
  return state.apply(applyEditsTr(state, edits, info));
}

const textOf = (state: EditorState) => state.doc.textBetween(0, state.doc.content.size, "\n");

/** Apply a transaction, keeping undo working the way it does in the editor. */
function run(state: EditorState, cmd: (s: EditorState, d: (tr: import("@tiptap/pm/state").Transaction) => void) => boolean): EditorState {
  let next = state;
  cmd(state, (tr) => {
    next = state.apply(tr);
  });
  return next;
}

describe("Vizzy's changes in the editor", () => {
  it("applies a request's edits as tracked changes", () => {
    const s0 = fresh();
    const s1 = applyVizzy(s0, [edit(s0, "line here", "row"), edit(s0, "is long", "is short")]);
    expect(textOf(s1)).toBe("First row.\nSecond line stays.\nThird line is short.");
    const pending = vizzyPending(s1);
    expect(pending.map((p) => s1.doc.textBetween(p.from, p.to))).toEqual(["row", "is short"]);
    expect(pending.map((p) => p.beforePlain)).toEqual(["line here", "is long"]);
  });

  it("Undo puts back exactly what was there, and Undo all does it for every change", () => {
    const s0 = fresh();
    const s1 = applyVizzy(s0, [edit(s0, "line here", "row"), edit(s0, "is long", "is short")]);
    const [a] = vizzyPending(s1);
    const s2 = s1.apply(undoSuggestionsTr(s1, [a!.id])!);
    expect(textOf(s2)).toBe("First line here.\nSecond line stays.\nThird line is short.");
    expect(vizzyResolved(s2)).toMatchObject([{ outcome: "undone", via: "button" }]);
    const s3 = s2.apply(undoSuggestionsTr(s2, vizzyPending(s2).map((p) => p.id))!);
    expect(s3.doc.eq(s0.doc)).toBe(true);
    expect(vizzyPending(s3)).toEqual([]);
  });

  it("Keep leaves the text and drops the highlight", () => {
    const s0 = fresh();
    const s1 = applyVizzy(s0, [edit(s0, "line here", "row")]);
    const s2 = s1.apply(keepSuggestionsTr(s1));
    expect(textOf(s2)).toBe(textOf(s1));
    expect(vizzyPending(s2)).toEqual([]);
    expect(vizzyResolved(s2)).toMatchObject([{ outcome: "kept", via: "button" }]);
  });

  it("typing next to a change moves it; typing inside keeps it as the person's own", () => {
    const s0 = fresh();
    const s1 = applyVizzy(s0, [edit(s0, "is long", "is short")]);
    const p = vizzyPending(s1)[0]!;
    const s2 = s1.apply(s1.tr.insertText("really ", p.to - "short".length - 3));
    expect(vizzyPending(s2)).toHaveLength(1);
    const before = s1.apply(s1.tr.insertText("Now ", range(s1, "Third").from));
    expect(before.doc.textBetween(vizzyPending(before)[0]!.from, vizzyPending(before)[0]!.to)).toBe("is short");
    const inside = s1.apply(s1.tr.insertText("x", p.from + 2));
    expect(vizzyPending(inside)).toEqual([]);
    expect(vizzyResolved(inside)).toMatchObject([{ outcome: "kept", via: "edited" }]);
  });

  it("deleting a change undoes it", () => {
    const s0 = fresh();
    const s1 = applyVizzy(s0, [edit(s0, "is long", "is short")]);
    const p = vizzyPending(s1)[0]!;
    const s2 = s1.apply(s1.tr.delete(p.from, p.to));
    expect(vizzyResolved(s2)).toMatchObject([{ outcome: "undone", via: "collapsed" }]);
  });

  it("Cmd-Z undoes Vizzy's change on its own, after the person's typing", () => {
    const s0 = fresh();
    const typed = s0.apply(s0.tr.insertText("!", range(s0, "stays").to));
    const s1 = applyVizzy(typed, [edit(typed, "is long", "is short")]);
    const s2 = run(s1, undo);
    expect(textOf(s2)).toBe("First line here.\nSecond line stays!.\nThird line is long.");
    expect(vizzyResolved(s2)).toMatchObject([{ outcome: "undone", via: "history" }]);
  });

  it("tracks words Vizzy removed, and Cmd-Z or Undo brings them back", () => {
    const s0 = fresh();
    const s1 = applyVizzy(s0, [edit(s0, " here", "")]);
    const p = vizzyPending(s1)[0]!;
    expect(p).toMatchObject({ kind: "deletion" });
    expect(p.from).toBe(p.to);
    expect(textOf(s1.apply(undoSuggestionsTr(s1, [p.id])!))).toBe(textOf(s0));
    const s2 = run(s1, undo);
    expect(textOf(s2)).toBe(textOf(s0));
    expect(vizzyResolved(s2)).toMatchObject([{ outcome: "undone", via: "history" }]);
  });

  it("follows the asked-about text, and clears without logging", () => {
    const s0 = fresh();
    const s1 = s0.apply(setTargetTr(s0, range(s0, "is long")));
    const s2 = s1.apply(s1.tr.insertText("Now ", range(s1, "Third").from));
    expect(s2.doc.textBetween(vizzyTarget(s2)!.from, vizzyTarget(s2)!.to)).toBe("is long");
    const s3 = applyVizzy(s2, [edit(s2, "is long", "is short")]);
    expect(vizzyTarget(s3)).toBeNull();
    const s4 = s3.apply(clearSuggestionsTr(s3));
    expect(vizzyPending(s4)).toEqual([]);
    expect(vizzyResolved(s4)).toEqual([]);
  });
});
