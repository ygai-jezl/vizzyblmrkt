import { LABEL_WORDS } from "./words";
import type { MetricBlock, Slide } from "./types";

/**
 * How a number sits inside a slide's words: stored text holds {{mb_xxxxxxxx}} (the block's display)
 * and {{mb_xxxxxxxx:period}} (its period words), so the figure always comes from its block and
 * never from the words around it. Rendering, word counts, talk time and number formatting. Pure and
 * client safe.
 */

const TOKEN = "\\{\\{(mb_[a-z0-9]{8})(?::(period))?\\}\\}";
/** A fresh global regex each call, so no caller shares lastIndex. */
export const tokenRe = () => new RegExp(TOKEN, "g");

export type Segment = { kind: "text"; text: string } | { kind: "block"; id: string; part: "display" | "period" };

/** The text as plain runs and number tokens, in order. */
export function segmentsOf(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(tokenRe())) {
    const i = m.index ?? 0;
    if (i > at) out.push({ kind: "text", text: text.slice(at, i) });
    out.push({ kind: "block", id: m[1]!, part: m[2] === "period" ? "period" : "display" });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** Segments back to stored text. */
export function textOf(segments: readonly Segment[]): string {
  return segments.map((s) => (s.kind === "text" ? s.text : s.part === "period" ? `{{${s.id}:period}}` : `{{${s.id}}}`)).join("");
}

/** The block ids a text names, each once, in order. */
export function tokenIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(tokenRe())].map((m) => m[1]!))];
}

/** The text with every token replaced by its block's words; a token for a removed block renders as nothing. */
export function renderText(text: string, blocks: readonly Pick<MetricBlock, "id" | "display" | "periodWords">[]): string {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return text
    .replace(tokenRe(), (_m, id: string, part?: string) => {
      const b = byId.get(id);
      if (!b) return "";
      return part === "period" ? (b.periodWords ?? "") : b.display;
    })
    .replace(/ {2,}/g, " ");
}

/** The text without the tokens for blocks not in `ids` (a removed block's token goes on save). */
export function keepTokens(text: string, ids: ReadonlySet<string>): string {
  return text.replace(tokenRe(), (m, id: string) => (ids.has(id) ? m : "")).replace(/ {2,}/g, " ");
}

/** The text with every token taken out, for finding numbers typed by hand. */
export function stripTokens(text: string): string {
  return text.replace(tokenRe(), " ");
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** What a viewer reads on the slide, rendered: headline, points, compare cells and people lines. */
export function slideTextParts(slide: Pick<Slide, "headline" | "points" | "compare" | "people" | "blocks">): string[] {
  const r = (t: string) => renderText(t, slide.blocks);
  const out = [r(slide.headline), ...slide.points.map(r)];
  if (slide.compare) out.push(slide.compare.leftTitle, slide.compare.rightTitle, ...slide.compare.rows.flatMap((row) => [r(row.left), r(row.right)]));
  for (const p of slide.people ?? []) out.push(p.name, p.role, p.line);
  return out.filter((t) => t.trim());
}

/** Words in the speaker notes: the talk track. */
export function wordsOf(slide: Pick<Slide, "notes" | "blocks">): number {
  return countWords(renderText(slide.notes, slide.blocks));
}

/** Words on the slide itself (not its notes). */
export function slideWordsOf(slide: Pick<Slide, "headline" | "points" | "compare" | "people" | "blocks">): number {
  return slideTextParts(slide).reduce((n, t) => n + countWords(t), 0);
}

/** Talk words a minute, our estimate. */
export const WORDS_A_MINUTE = 150;

/** How long the words take to say, in whole seconds. */
export function talkSeconds(words: number): number {
  return Math.round((words / WORDS_A_MINUTE) * 60);
}

/** "40 seconds", "1 minute", "3 minutes". */
export function talkTime(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const m = Math.round(seconds / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

/** "m:ss", for the Present timer. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ----- Numbers ---------------------------------------------------------------------------------

const SIGN = { GBP: "£", USD: "$", EUR: "€" } as const;

export function formatNumber(n: number): string {
  const digits = Number.isInteger(n) || Math.abs(n) >= 100 ? 0 : 2;
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
}

/** A block's figure as a slide shows it: "4,310", "£14,200 a month", "+18%". */
export function formatValue(b: Pick<MetricBlock, "value" | "unit" | "currency" | "per">): string {
  if (b.value === null) return "";
  let out: string;
  if (b.unit === "percent") {
    const v = Math.round(b.value);
    out = `${v > 0 ? "+" : ""}${formatNumber(v)}%`;
  } else if (b.unit === "money") {
    const sign = SIGN[b.currency ?? "GBP"];
    out = b.value < 0 ? `-${sign}${formatNumber(-b.value)}` : `${sign}${formatNumber(b.value)}`;
  } else {
    out = formatNumber(b.value);
  }
  if (b.per) out += b.per === "month" ? " a month" : " a year";
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Nov", or "26 Nov 2025" outside the year of `now` (UTC). */
export function dayWords(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`;
}

/** "12 weeks to 26 Nov". */
export function periodWordsFor(weeks: number, endIso: string, now: Date = new Date()): string {
  return `${weeks} weeks to ${dayWords(endIso, now)}`;
}

/** Where a number came from, with its date: "Seen by YouGrow, 26 Nov", "Typed by you, from your till, 26 Nov". */
export function labelWords(b: Pick<MetricBlock, "source" | "asOf">, now: Date = new Date()): string {
  const day = dayWords(b.asOf, now);
  if (b.source.kind !== "typed") return `${LABEL_WORDS.seen}, ${day}`;
  return b.source.from ? `${LABEL_WORDS.typed}, from ${b.source.from}, ${day}` : `${LABEL_WORDS.typed}, ${day}`;
}
