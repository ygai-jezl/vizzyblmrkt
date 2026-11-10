import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { emailEditProblem } from "@/lib/email/emailDoc";
import type { EditFormat } from "./extensions";

/**
 * Checks on a change Vizzy proposes, before anyone sees it. `hard` problems stop the change (a
 * merge value or link lost or made up, code changed, HTML Edit mode can't keep); `soft` ones
 * are shown beside it (an AI tell, a dash, words repeated from around the selection). Run by
 * the route on what the model wrote, and by the editor on the exact text being replaced. Pure.
 */

const TOKEN = /\{\{[^{}\n]{1,80}\}\}/g;
const BLOCK_TOKEN = /\{\{\s*block\.[a-z_]+\s*\}\}/g;
const MD_LINK = /\]\(\s*([^()\s]+)\s*\)/g;
const HTML_HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const URL_IN_TEXT = /\b(?:https?:\/\/|mailto:)[^\s<>"')\]]+/gi;
const CODE_FENCE = /```[^\n]*\n[\s\S]*?\n```/g;

/** The merge values in some text ("{{first_name}}"), each once. */
export function tokensIn(text: string): string[] {
  return [...new Set(text.match(TOKEN) ?? [])];
}

/** The link targets in some Markdown or email HTML, each once. */
export function hrefsIn(format: EditFormat, text: string): string[] {
  const out = new Set<string>();
  if (format === "email") {
    for (const m of text.matchAll(HTML_HREF)) out.add((m[1] ?? m[2] ?? "").trim());
  } else {
    for (const m of text.matchAll(MD_LINK)) out.add((m[1] ?? "").trim());
  }
  out.delete("");
  return [...out];
}

function urlsIn(text: string): string[] {
  return text.match(URL_IN_TEXT) ?? [];
}

/** The words, without email tags. */
function plainOf(format: EditFormat, text: string): string {
  return format === "email" ? text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ") : text;
}

/** Each block value must be a paragraph of its own, the shape the lifecycle renderer draws. */
function blockTokensAlone(html: string, shape: ChangeShape): boolean {
  const count = (html.match(BLOCK_TOKEN) ?? []).length;
  if (!count) return true;
  if (shape !== "blocks") return html.trim().replace(BLOCK_TOKEN, "").trim() === "" && count === 1;
  const alone = html.match(/<p>\s*\{\{\s*block\.[a-z_]+\s*\}\}\s*<\/p>/g) ?? [];
  return alone.length === count;
}

const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function quoteList(items: string[]): string {
  const q = items.map((i) => `"${i}"`);
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}` : (q[0] ?? "");
}

/** "inline": part of a line. "blocks": whole blocks. "words": a word changed everywhere. */
export type ChangeShape = "inline" | "blocks" | "words";

export interface ChangeCheckInput {
  format: EditFormat;
  shape: ChangeShape;
  /** What is there now, in the stored format ("" for new blocks). */
  before: string;
  /** What Vizzy wrote, in the stored format. */
  after: string;
  /** What the person asked for: a value or link they name may come or go. */
  instruction: string;
  /** The merge values this text may use. */
  allowedTokens?: readonly string[];
  /** Links elsewhere in the text, which a change may use again. */
  docHrefs?: readonly string[];
  /** The text just before and after a selection, to catch it written twice. */
  contextBefore?: string;
  contextAfter?: string;
}

export interface ChangeProblems {
  hard: string[];
  soft: string[];
}

export function changeProblems(i: ChangeCheckInput): ChangeProblems {
  const hard: string[] = [];
  const soft: string[] = [];
  const asked = i.instruction;

  const beforeTokens = tokensIn(i.before);
  const afterTokens = tokensIn(i.after);
  for (const t of beforeTokens) {
    if (!afterTokens.includes(t) && !asked.includes(t)) hard.push(`Vizzy's version dropped ${t}, so it wasn't used.`);
  }
  const allowedTokens = new Set([...beforeTokens, ...(i.allowedTokens ?? []), ...tokensIn(asked)]);
  for (const t of afterTokens) {
    if (!allowedTokens.has(t)) hard.push(`Vizzy's version added ${t}, which isn't a merge value here, so it wasn't used.`);
  }

  const beforeLinks = hrefsIn(i.format, i.before);
  const afterLinks = hrefsIn(i.format, i.after);
  if (!/\blinks?\b/i.test(asked)) {
    for (const h of beforeLinks) {
      if (!afterLinks.includes(h)) hard.push(`Vizzy's version dropped the link to ${h}, so it wasn't used.`);
    }
  }
  const knownLinks = new Set([...beforeLinks, ...(i.docHrefs ?? []), ...urlsIn(asked)]);
  for (const h of afterLinks) {
    if (!knownLinks.has(h)) hard.push(`Vizzy's version added a link to ${h} that isn't in your text, so it wasn't used.`);
  }

  if (i.format === "email") {
    if (!blockTokensAlone(i.after, i.shape)) hard.push("Vizzy's version moved a block value into a sentence, so it wasn't used.");
    const kept = emailEditProblem(i.after);
    if (kept) hard.push(`Vizzy's version has HTML Edit mode can't keep (${kept.join(", ")}), so it wasn't used.`);
  } else {
    const after = new Set(i.after.match(CODE_FENCE) ?? []);
    if ((i.before.match(CODE_FENCE) ?? []).some((c) => !after.has(c))) {
      hard.push("Vizzy's version changed a code block, so it wasn't used.");
    }
  }

  if (i.shape !== "blocks" && /\n\s*\n/.test(i.after.trim())) {
    hard.push("Vizzy's version has more than one paragraph. Select whole paragraphs to change their shape.");
  }

  const tellsBefore = new Set(aiTellsIn(plainOf(i.format, i.before)));
  const newTells = aiTellsIn(plainOf(i.format, i.after)).filter((t) => !tellsBefore.has(t));
  if (newTells.length) soft.push(`It uses ${quoteList(newTells)}, which reads as AI writing.`);
  if (dashesIn(plainOf(i.format, i.after)).length > dashesIn(plainOf(i.format, i.before)).length) {
    soft.push("It uses a dash as punctuation.");
  }

  const after = fold(plainOf(i.format, i.after));
  const before = fold(plainOf(i.format, i.before));
  const tail = fold(i.contextBefore ?? "").slice(-30);
  const head = fold(i.contextAfter ?? "").slice(0, 30);
  const echoes = (bit: string) => bit.length >= 20 && after.includes(bit) && !before.includes(bit);
  if (echoes(tail) || echoes(head)) soft.push("It repeats words from around your selection.");

  if (i.format !== "email" && i.shape === "blocks") {
    if (/^\|.*\|\s*$/m.test(i.before) && !/^\|.*\|\s*$/m.test(i.after)) soft.push("It removed a table.");
    if (/^>\s*\*\*/m.test(i.before) && !/^>\s*\*\*/m.test(i.after)) soft.push("It removed a box.");
  }

  return { hard, soft };
}
