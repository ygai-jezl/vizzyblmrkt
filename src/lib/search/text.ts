import { createHash } from "node:crypto";
import { htmlToText } from "@/lib/content/create/siteText";

/**
 * Text helpers for brand search: plain text out of what a brand wrote, chunks to embed, the
 * words queries we send (Firestore's text search ANDs every term, so a question needs one query
 * per key term as well), a local stand-in for text search on the emulator (which has no
 * search() stage), and reciprocal rank fusion. Pure.
 */

/** Characters per chunk. About 300 tokens: well inside the embedding model's 2,048. */
export const CHUNK_CHARS = 1200;
/** Characters a chunk repeats from the one before, so a sentence across a break is still found. */
export const CHUNK_OVERLAP = 150;
/** A record is cut off after this many chunks (a very long knowledge page), to bound the cost. */
export const MAX_CHUNKS_PER_SOURCE = 200;

/** Markdown to readable text: drop the markup, keep the words. */
export function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*\n?/gi, ""))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*([-*_]\s*){3,}$/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toPlainText(body: string, format: "plain" | "markdown" | "html" = "plain"): string {
  const text = format === "html" ? htmlToText(body ?? "") : format === "markdown" ? markdownToText(body ?? "") : String(body ?? "");
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split text into chunks of about CHUNK_CHARS, breaking at a paragraph, then a sentence, then a
 * space, with CHUNK_OVERLAP characters carried into the next chunk.
 */
export function chunkText(text: string, max = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length && out.length < MAX_CHUNKS_PER_SOURCE) {
    let end = Math.min(clean.length, start + max);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const floor = Math.floor(max * 0.5);
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "), window.lastIndexOf("\n"));
      const space = window.lastIndexOf(" ");
      const cut = para > floor ? para : sentence > floor ? sentence + 1 : space > floor ? space : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
    // Begin the next chunk at a word.
    const nextSpace = clean.indexOf(" ", start);
    if (nextSpace > 0 && nextSpace < end) start = nextSpace + 1;
  }
  return out;
}

export function contentHash(...parts: Array<string | string[] | undefined>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(Array.isArray(p) ? p.join("\u0000") : (p ?? "")).update("\u0001");
  return h.digest("hex").slice(0, 32);
}

/** Words a search drops: on their own they match almost everything, and Firestore ANDs every term. */
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our " +
    "so that the their them then there these they this to was we what when where which who why will with you your " +
    "about any all also get got need should could would just"
  ).split(" "),
);

/** The terms of a query: lower case, punctuation gone, hyphenated codes kept whole ("fl-204"). */
export function queryTerms(query: string): string[] {
  const phrases: string[] = [];
  const rest = String(query ?? "").replace(/"([^"]{1,200})"/g, (_m, p: string) => {
    phrases.push(p);
    return " ";
  });
  const words = rest
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w && !STOP_WORDS.has(w) && w !== "or" && w !== "and");
  const quoted = phrases.map((p) => `"${p.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim()}"`).filter((p) => p.length > 2);
  return [...new Set([...quoted, ...words])].slice(0, 12);
}

/**
 * The words queries for one search, most specific first: every term together, then each of the
 * longest few terms on its own. Firestore's text search ANDs the terms of a query and has no OR
 * (checked on a real database, S0), so a question like "what kit do I need for returns" only
 * finds something through the single-term queries. Empty when nothing is left to search.
 */
export function wordsQueries(query: string, maxSingles = 4): string[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const all = terms.join(" ");
  if (terms.length === 1) return [all];
  const singles = [...terms].sort((a, b) => b.length - a.length).slice(0, maxSingles);
  return [all, ...singles.filter((t) => t !== all)];
}

/** A rough stem, so "repotting" and "repot", "kits" and "kit" meet (the local stand-in only). */
function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ["ings", "ing", "ers", "er", "ies", "es", "ed", "s"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

function textTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const raw = lower.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    const trimmed = t.replace(/^-+|-+$/g, "");
    if (!trimmed) continue;
    out.push(stem(trimmed));
    if (trimmed.includes("-")) {
      out.push(trimmed.replace(/-/g, ""));
      for (const part of trimmed.split("-")) if (part) out.push(stem(part));
    }
  }
  return out;
}

/**
 * The local stand-in for text search, used only on the emulator: a document matches when every
 * term (or quoted phrase) is in its title or text, like Firestore's text search. Score: how often
 * the terms appear, a title hit counting three times. 0 means no match.
 */
export function localWordsScore(query: string, doc: { title: string; text: string }): number {
  const parts = query.match(/"[^"]+"|\S+/g) ?? [];
  if (!parts.length) return 0;
  const titleLower = doc.title.toLowerCase();
  const textLower = doc.text.toLowerCase();
  const titleTokens = textTokens(doc.title);
  const textTokensList = textTokens(doc.text);
  let score = 0;
  for (const part of parts) {
    if (part.startsWith('"')) {
      const phrase = part.slice(1, -1).toLowerCase().trim();
      if (!phrase) continue;
      const inTitle = titleLower.includes(phrase) ? 1 : 0;
      const inText = textLower.split(phrase).length - 1;
      if (!inTitle && !inText) return 0;
      score += inTitle * 3 + inText;
      continue;
    }
    const term = part.toLowerCase().replace(/^-+|-+$/g, "");
    const want = [stem(term), term.replace(/-/g, "")];
    const hits = (tokens: string[]) => tokens.filter((t) => want.some((w) => w && (t === w || (w.length >= 4 && t.startsWith(w))))).length;
    const t = hits(titleTokens);
    const b = hits(textTokensList);
    if (!t && !b) return 0;
    score += t * 3 + b;
  }
  return score;
}

/** The constant in reciprocal rank fusion: each list adds 1 / (k + rank). 60 is the usual value. */
export const RRF_K = 60;

/** Merge ranked lists of ids into one order. `weights` lets a list count more (default 1 each). */
export function reciprocalRankFusion(lists: string[][], weights: number[] = []): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + w / (RRF_K + i + 1));
    });
  });
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
