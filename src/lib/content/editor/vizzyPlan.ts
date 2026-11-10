import type { JSONContent } from "@tiptap/core";
import { Fragment, type Mark, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { docLoss, inlineMarkdownToContent, markdownToDoc } from "./markdownDoc";
import { isMarkdownFormat, type EditFormat } from "./extensions";
import { ANCHOR_MISS, anchorText, findAnchor, findWords, matchCase, textblocksOf } from "./vizzyAnchor";
import { changeProblems, hrefsIn } from "./vizzyChecks";
import { VIZZY_LIMITS, excerptOf, type VizzySkipped, type VizzySuggestedOp } from "./vizzyOps";
import { plainBetween, type Serializer, type VizzyTarget } from "./vizzySelection";

/**
 * Vizzy's answer as edits to the live document, checked again on the exact text they replace.
 * An edit that can't be placed, would lose a merge value or link, or would change what the saved
 * Markdown can hold is skipped with the reason, never inserted. Pure: the editor applies the
 * edits (vizzyPlugin.ts).
 */

export interface PlannedEdit {
  from: number;
  to: number;
  content: Fragment;
  kind: "inline" | "block";
  /** The text replaced and the text written, in the stored format (for the panel and the log). */
  beforeText: string;
  afterText: string;
  warnings: string[];
}

export class PlanError extends Error {}

/** Vizzy's text as document content: one line of inline content, or whole blocks. Throws
 *  PlanError when the text doesn't fit. */
export interface FragmentMaker {
  inline(text: string): Fragment;
  blocks(text: string): Fragment;
}

const MORE_THAN_ONE = "Vizzy's version has more than one paragraph. Select whole paragraphs to change their shape.";

export function markdownFragments(schema: Schema, format: EditFormat): FragmentMaker {
  return {
    inline(text) {
      const one = text.replace(/\r\n/g, "\n").trim();
      if (/\n\s*\n/.test(one)) throw new PlanError(MORE_THAN_ONE);
      return Fragment.fromJSON(schema, inlineMarkdownToContent(one.replace(/\s*\n\s*/g, " "), format));
    },
    blocks(text) {
      const content = Fragment.fromJSON(schema, markdownToDoc(text, format).content ?? []);
      content.forEach((node) => node.check());
      return content;
    },
  };
}

/** The marks every piece of text in a range shares (a bold phrase stays bold when one word in it
 *  is changed). */
function sharedMarks(doc: PMNode, from: number, to: number): readonly Mark[] {
  let shared: readonly Mark[] | null = null;
  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    shared = shared === null ? node.marks : shared.filter((m) => m.isInSet(node.marks));
    return false;
  });
  return shared ?? [];
}

/** Plain new text takes the marks of the words it replaces. */
function withMarks(content: Fragment, marks: readonly Mark[]): Fragment {
  if (!marks.length) return content;
  const nodes: PMNode[] = [];
  content.forEach((node) => {
    if (!node.isText || node.marks.length) {
      nodes.push(node);
      return;
    }
    nodes.push(node.mark(marks.reduce((set, m) => m.addToSet(set), node.marks)));
  });
  return Fragment.fromArray(nodes);
}

/** What saving would lose in the top-level blocks an edit touches, as a reason, or null. */
function lossOf(state: EditorState, edit: Pick<PlannedEdit, "from" | "to" | "content">, format: EditFormat): string | null {
  if (!isMarkdownFormat(format)) return null;
  let tr;
  try {
    tr = state.tr.replaceWith(edit.from, edit.to, edit.content);
  } catch {
    return "That change doesn't fit there, so it wasn't made.";
  }
  const a = tr.mapping.map(edit.from, -1);
  const b = tr.mapping.map(edit.to, 1);
  const touched: JSONContent[] = [];
  tr.doc.nodesBetween(Math.max(0, a - 1), Math.min(tr.doc.content.size, b + 1), (node, _pos, parent) => {
    if (parent === tr.doc) touched.push(node.toJSON() as JSONContent);
    return false;
  });
  return docLoss({ type: "doc", content: touched }, format)
    ? "Vizzy's version has formatting the saved Markdown can't hold, so it wasn't used."
    : null;
}

export interface PlanInput {
  state: EditorState;
  format: EditFormat;
  make: FragmentMaker;
  ser: Serializer;
  instruction: string;
  tokens?: readonly string[];
}

/** A selection's replacement as one edit, or why it can't be made. */
export function planSelectionEdit(
  input: PlanInput & { target: VizzyTarget; replacement: string; warnings: string[] },
): { edit: PlannedEdit } | { error: string } {
  const { state, target, format } = input;
  const doc = state.doc;
  if (target.to > doc.content.size || plainBetween(doc, target.from, target.to) !== target.plain) {
    return { error: "The text changed while Vizzy was working. Ask again." };
  }
  const checked = changeProblems({
    format,
    shape: target.shape,
    before: target.text,
    after: input.replacement,
    instruction: input.instruction,
    allowedTokens: input.tokens,
    contextBefore: target.before,
    contextAfter: target.after,
  });
  if (checked.hard[0]) return { error: checked.hard[0] };
  let content: Fragment;
  try {
    content = target.shape === "inline" ? input.make.inline(input.replacement) : input.make.blocks(input.replacement);
  } catch (e) {
    return { error: e instanceof PlanError ? e.message : "Vizzy's version couldn't be placed in the text. Ask again." };
  }
  const edit: PlannedEdit = {
    from: target.from,
    to: target.to,
    content,
    kind: target.shape === "inline" ? "inline" : "block",
    beforeText: target.text,
    afterText: input.replacement,
    warnings: [...new Set([...input.warnings, ...checked.soft])],
  };
  const loss = lossOf(state, edit, format);
  return loss ? { error: loss } : { edit };
}

/** Where new blocks go after the words: after their list item when the new blocks are items of
 *  the same kind of list, after their block inside a box or quotation, else after their
 *  top-level block. */
function insertPlace(doc: PMNode, at: number, content: Fragment): { pos: number; content: Fragment } {
  const $at = doc.resolve(at);
  for (let d = $at.depth; d > 0; d -= 1) {
    const node = $at.node(d);
    if (node.type.name === "listItem") {
      const list = $at.node(d - 1);
      const only = content.childCount === 1 ? content.firstChild : null;
      if (only && only.type === list.type) return { pos: $at.after(d), content: only.content };
    }
  }
  const boxed = $at.depth >= 2 && ["articleBox", "blockquote"].includes($at.node(1).type.name);
  return { pos: $at.after(boxed ? 2 : 1), content };
}

/** The ops for the whole piece as edits, in document order, with the ones skipped and why. */
export function planWholeEdits(
  input: PlanInput & { ops: VizzySuggestedOp[]; pending?: readonly { from: number; to: number }[] },
): { edits: PlannedEdit[]; skipped: VizzySkipped[] } {
  const { state, format, make, ser } = input;
  const doc = state.doc;
  const blocks = textblocksOf(doc);
  const candidates: PlannedEdit[] = [];
  const skipped: VizzySkipped[] = [];
  const skip = (words: string, reason: string) => skipped.push({ excerpt: excerptOf(words), reason });
  const code = doc.type.schema.marks.code;
  let docHrefs: string[] | null = null;
  const linksInDoc = () => (docHrefs ??= hrefsIn(format, ser.blocks(doc.content)));

  for (const { op, warnings } of input.ops) {
    try {
      if (op.op === "replace_all") {
        const found = findWords(blocks, op.find, VIZZY_LIMITS.REPLACE_ALL);
        if (!found.length) skip(op.find, ANCHOR_MISS.not_found);
        for (const f of found) {
          if (code && doc.rangeHasMark(f.from, f.to, code)) continue;
          const text = matchCase(f.text, op.replace);
          const marks = sharedMarks(doc, f.from, f.to);
          candidates.push({
            from: f.from,
            to: f.to,
            content: text ? Fragment.from(doc.type.schema.text(text, marks)) : Fragment.empty,
            kind: "inline",
            beforeText: f.text,
            afterText: text,
            warnings,
          });
        }
        continue;
      }

      const anchor = op.op === "replace" ? op.find : op.after;
      const hit = findAnchor(blocks, anchorText(anchor, format));
      if (!hit.ok) {
        skip(anchor, ANCHOR_MISS[hit.reason]);
        continue;
      }
      if (op.op === "replace") {
        const before = ser.inline(doc.slice(hit.from, hit.to).content, false);
        const checked = changeProblems({
          format,
          shape: "inline",
          before,
          after: op.replace,
          instruction: input.instruction,
          allowedTokens: input.tokens,
          docHrefs: linksInDoc(),
        });
        if (checked.hard[0]) {
          skip(anchor, checked.hard[0]);
          continue;
        }
        const content = withMarks(make.inline(op.replace), sharedMarks(doc, hit.from, hit.to));
        candidates.push({
          from: hit.from,
          to: hit.to,
          content,
          kind: "inline",
          beforeText: before,
          afterText: op.replace,
          warnings: [...new Set([...warnings, ...checked.soft])],
        });
      } else {
        const checked = changeProblems({
          format,
          shape: "blocks",
          before: "",
          after: op.insert,
          instruction: input.instruction,
          allowedTokens: input.tokens,
          docHrefs: linksInDoc(),
        });
        if (checked.hard[0]) {
          skip(anchor, checked.hard[0]);
          continue;
        }
        const place = insertPlace(doc, hit.from, make.blocks(op.insert));
        candidates.push({
          from: place.pos,
          to: place.pos,
          content: place.content,
          kind: "block",
          beforeText: "",
          afterText: op.insert,
          warnings: [...new Set([...warnings, ...checked.soft])],
        });
      }
    } catch (e) {
      skip(op.op === "insert_after" ? op.after : op.find, e instanceof PlanError ? e.message : "That change couldn't be placed in the text.");
    }
  }

  const edits: PlannedEdit[] = [];
  const taken = [...(input.pending ?? [])];
  const overlaps = (e: { from: number; to: number }, r: { from: number; to: number }) =>
    e.from === e.to ? e.from > r.from && e.from < r.to : e.from < r.to && e.to > r.from;
  for (const e of [...candidates].sort((x, y) => x.from - y.from || x.to - y.to)) {
    const words = e.beforeText || e.afterText;
    if (taken.some((r) => overlaps(e, r))) {
      skip(words, "It overlaps another change, so nothing changed there.");
      continue;
    }
    const loss = lossOf(state, e, format);
    if (loss) {
      skip(words, loss);
      continue;
    }
    edits.push(e);
    taken.push({ from: e.from, to: e.to });
  }
  return { edits, skipped };
}
