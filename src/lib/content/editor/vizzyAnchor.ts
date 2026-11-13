import type { Node as PMNode } from "@tiptap/pm/model";
import { inlineMarkdownToContent } from "./markdownDoc";
import { isMarkdownFormat, type EditFormat } from "./extensions";

/**
 * Finding the exact words an edit is for in the live document. Each paragraph, heading, list
 * item line or cell is searched on its own (an edit never spans two), and the words must appear
 * exactly once outside code; otherwise the edit is skipped with the reason. Text offsets equal
 * document positions inside a block: every character is one position, and an inline leaf (a
 * line break) is read as one stand-in character. Pure.
 */

/** Read in place of an inline leaf, so offsets stay positions. */
export const LEAF = "￼";

export interface Textblock {
  /** The position before the block (its content starts at pos + 1). */
  pos: number;
  node: PMNode;
  text: string;
  inCode: boolean;
}

export function textblocksOf(doc: PMNode): Textblock[] {
  const out: Textblock[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    out.push({ pos, node, text: node.textBetween(0, node.content.size, "", LEAF), inCode: node.type.spec.code === true });
    return false;
  });
  return out;
}

/** Quotes and spaces folded one character for one, so offsets don't move. */
export function normalizeForMatch(s: string): string {
  return s.replace(/ /g, " ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** The plain words of an edit's anchor as the document holds them, or null when it spans
 *  blocks. The model may quote Markdown ("**Pricing**", "## Week 1") or email HTML. */
export function anchorText(anchor: string, format: EditFormat): string | null {
  const one = anchor.replace(/\r\n/g, "\n").trim();
  if (!one || /\n/.test(one)) return null;
  if (!isMarkdownFormat(format)) {
    return one.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, e: string) => ENTITIES[e] ?? "");
  }
  const bare = one.replace(/^(?:#{1,6}\s+|[-+*]\s+|\d{1,3}[.)]\s+|>\s*)/, "");
  return inlineMarkdownToContent(bare, format)
    .map((n) => n.text ?? "")
    .join("");
}

export type AnchorResult =
  | { ok: true; block: Textblock; from: number; to: number }
  | { ok: false; reason: AnchorMiss };

export type AnchorMiss = "not_found" | "ambiguous" | "in_code" | "spans_blocks";

export const ANCHOR_MISS: Record<AnchorMiss, string> = {
  not_found: "Vizzy couldn't find those words, so nothing changed there.",
  ambiguous: "Those words appear more than once, so nothing changed there.",
  in_code: "Those words are in code, which Vizzy doesn't change.",
  spans_blocks: "That change runs across more than one paragraph, so nothing changed there.",
};

/** Where the words are, if they appear exactly once outside code. */
export function findAnchor(blocks: Textblock[], words: string | null): AnchorResult {
  if (words === null) return { ok: false, reason: "spans_blocks" };
  const needle = normalizeForMatch(words);
  if (!needle.trim()) return { ok: false, reason: "not_found" };
  let hit: { block: Textblock; at: number } | null = null;
  let count = 0;
  let inCode = false;
  for (const block of blocks) {
    const hay = normalizeForMatch(block.text);
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      if (block.inCode) {
        inCode = true;
      } else {
        count += 1;
        hit = { block, at };
      }
    }
  }
  if (count === 1 && hit) {
    const from = hit.block.pos + 1 + hit.at;
    return { ok: true, block: hit.block, from, to: from + needle.length };
  }
  if (count > 1) return { ok: false, reason: "ambiguous" };
  return { ok: false, reason: inCode ? "in_code" : "not_found" };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every place a word or short phrase appears as whole words outside code, up to `max`, any
 *  case. */
export function findWords(blocks: Textblock[], words: string, max: number): { from: number; to: number; text: string }[] {
  const needle = normalizeForMatch(words.trim());
  if (!needle) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(needle)}(?![\\p{L}\\p{N}])`, "giu");
  const out: { from: number; to: number; text: string }[] = [];
  for (const block of blocks) {
    if (block.inCode) continue;
    for (const m of normalizeForMatch(block.text).matchAll(re)) {
      if (out.length >= max) return out;
      const from = block.pos + 1 + (m.index ?? 0);
      out.push({ from, to: from + m[0].length, text: block.text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length) });
    }
  }
  return out;
}

/** The new word in the old word's case: "Organize" becomes "Organise", "ORGANIZE" "ORGANISE". */
export function matchCase(found: string, replacement: string): string {
  if (!replacement) return replacement;
  if (found.length > 1 && found === found.toUpperCase() && found !== found.toLowerCase()) return replacement.toUpperCase();
  const first = found[0] ?? "";
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
