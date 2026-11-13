import type { JSONContent } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { contentToInlineMarkdown, docToMarkdown } from "./markdownDoc";
import { LEAF } from "./vizzyAnchor";
import { VIZZY_LIMITS } from "./vizzyOps";

/**
 * What a selection asks Vizzy to change. Part of one paragraph, heading, list item or cell is an
 * "inline" target (widened to whole words); anything else is widened to whole top-level blocks.
 * The text goes to Vizzy in the stored format, with a little text either side. Pure.
 */

export interface VizzyTarget {
  shape: "inline" | "blocks";
  from: number;
  to: number;
  /** The selection in the stored format, sent to Vizzy. */
  text: string;
  /** Its plain words when asked, to tell whether it changed while Vizzy worked. */
  plain: string;
  before: string;
  after: string;
}

/** The stored format of a piece of the document: Markdown here, email HTML in the browser. */
export interface Serializer {
  inline(content: Fragment, inCell: boolean): string;
  blocks(content: Fragment): string;
}

const asJson = (content: Fragment) => (content.toJSON() ?? []) as JSONContent[];

export const markdownSerializer: Serializer = {
  inline: (content, inCell) => contentToInlineMarkdown(asJson(content), inCell),
  blocks: (content) => docToMarkdown({ type: "doc", content: asJson(content) }),
};

/** About this much text either side of a selection goes with it. */
const CONTEXT = 600;

const isWordChar = (ch: string | undefined) => Boolean(ch && /[\p{L}\p{N}'’_-]/u.test(ch));

/** The plain words of a range, for comparing later. */
export function plainBetween(doc: PMNode, from: number, to: number): string {
  return doc.textBetween(from, to, "\n", LEAF);
}

function clipEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const space = cut.search(/\s/);
  return space >= 0 ? cut.slice(space + 1) : cut;
}

function clipStart(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.search(/\s\S*$/);
  return space >= 0 ? cut.slice(0, space) : cut;
}

/** Whole top-level blocks before `index` and from `end`, each way up to CONTEXT characters. */
function blocksAround(doc: PMNode, index: number, end: number, ser: Serializer): { before: string; after: string } {
  const before: string[] = [];
  let length = 0;
  for (let i = index - 1; i >= 0 && length < CONTEXT; i -= 1) {
    const text = ser.blocks(Fragment.from(doc.child(i)));
    if (!text) continue;
    before.unshift(text);
    length += text.length;
  }
  const after: string[] = [];
  length = 0;
  for (let i = end; i < doc.childCount && length < CONTEXT; i += 1) {
    const text = ser.blocks(Fragment.from(doc.child(i)));
    if (!text) continue;
    after.push(text);
    length += text.length;
  }
  return { before: clipEnd(before.join("\n\n"), CONTEXT), after: clipStart(after.join("\n\n"), CONTEXT) };
}

function hasCode(content: Fragment): boolean {
  let found = false;
  content.descendants((node) => {
    if (node.type.spec.code) found = true;
    return !found;
  });
  return found;
}

export function selectionTarget(state: EditorState, ser: Serializer): VizzyTarget | { error: string } {
  const { from, to, empty } = state.selection;
  if (empty) return { error: "Select some text first." };
  const doc = state.doc;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);

  if ($from.sameParent($to) && $from.parent.isTextblock) {
    const parent = $from.parent;
    if (parent.type.spec.code) return { error: "Vizzy doesn't change code. Select text outside the code block." };
    const start = $from.start();
    const text = parent.textBetween(0, parent.content.size, "", LEAF);
    let a = from - start;
    let b = to - start;
    while (a < b && /\s/.test(text[a] ?? "")) a += 1;
    while (b > a && /\s/.test(text[b - 1] ?? "")) b -= 1;
    if (a === b) return { error: "Select some words first." };
    while (a > 0 && isWordChar(text[a - 1]) && isWordChar(text[a])) a -= 1;
    while (b < text.length && isWordChar(text[b - 1]) && isWordChar(text[b])) b += 1;

    let inCell = false;
    for (let d = $from.depth; d > 0; d -= 1) {
      const name = $from.node(d).type.name;
      if (name === "tableCell" || name === "tableHeader") inCell = true;
    }
    const around = blocksAround(doc, $from.index(0), $from.index(0) + 1, ser);
    const ownBefore = ser.inline(parent.content.cut(0, a), inCell);
    const ownAfter = ser.inline(parent.content.cut(b), inCell);
    const selected = ser.inline(parent.content.cut(a, b), inCell);
    if (selected.length > VIZZY_LIMITS.SELECTION) {
      return { error: "That's a lot to change at once. Select less, or ask with nothing selected." };
    }
    return {
      shape: "inline",
      from: start + a,
      to: start + b,
      text: selected,
      plain: text.slice(a, b),
      before: clipEnd([around.before, ownBefore].filter(Boolean).join("\n\n"), CONTEXT),
      after: clipStart([ownAfter, around.after].filter(Boolean).join("\n\n"), CONTEXT),
    };
  }

  const a = $from.depth >= 1 ? $from.before(1) : 0;
  const b = $to.depth >= 1 ? $to.after(1) : doc.content.size;
  const content = doc.slice(a, b).content;
  if (hasCode(content)) return { error: "Vizzy doesn't change code. Select text outside the code block." };
  const text = ser.blocks(content);
  if (!text.trim()) return { error: "Select some words first." };
  if (text.length > VIZZY_LIMITS.SELECTION) {
    return { error: "That's a lot to change at once. Select less, or ask with nothing selected." };
  }
  const around = blocksAround(doc, doc.resolve(a).index(0), doc.resolve(b).index(0), ser);
  return { shape: "blocks", from: a, to: b, text, plain: plainBetween(doc, a, b), ...around };
}
