import type { BrandMapQuestionRecord } from "@/lib/types/brandMapRecords";
import type { DataSignal } from "@/lib/types/dataSignal";
import { daysIn, dayWords } from "../period";

/**
 * What a suggestion from collected numbers says (Connectors 2 group 4), in the approved Review
 * and brand map words: a title, its lines, and a proposed question's reason. Pure. A blanked row
 * says nothing. Every number is in the words, so whoever reads them sees what the rule saw.
 */

const n = (v: number | undefined) => Math.round(v ?? 0).toLocaleString("en-GB");
const position = (v: number | undefined) => (Math.round((v ?? 0) * 10) / 10).toFixed(1);
const span = (from: string, to: string) => `${daysIn(from, to)} days to ${dayWords(to)}`;

/** "up from 60", "up from at most 60", "up from none". */
function upFrom(before: number, atMost: boolean): string {
  if (before <= 0) return "up from none";
  return `up from ${atMost ? "at most " : ""}${n(before)}`;
}

/** The suggestion's heading, or null for a blanked row. */
export function signalTitle(s: Pick<DataSignal, "rule" | "label" | "question">): string | null {
  if (!s.label) return null;
  if (s.rule === "losing_page") return `Fewer Google clicks to ${s.label}`;
  if (s.rule === "within_reach") return `“${s.question ?? s.label}” could rank higher on Google`;
  return `More people search “${s.label}”`;
}

/**
 * Its lines, as Review shows them. With `site` (a brand with more than one Search Console site),
 * the first line says which site.
 */
export function signalLines(s: Pick<DataSignal, "rule" | "label" | "numbers" | "before" | "window" | "atMost" | "mayChange">, opts: { site?: string } = {}): string[] {
  const w = s.window;
  if (!s.label || !s.numbers || !w) return [];
  const on = opts.site ? `On ${opts.site}: ` : "";
  const m = s.numbers;
  const b = s.before ?? {};
  if (s.rule === "within_reach") {
    return [`${on}Average position ${position(m.searchPosition)} and ${n(m.searchImpressions)} impressions for the search “${s.label}” in the ${span(w.from, w.to)}.`];
  }
  if (s.rule === "losing_page") {
    const lines = [`${on}${s.atMost ? "At most " : ""}${n(m.searchClicks)} clicks in the ${span(w.from, w.to)}, down from ${n(b.searchClicks)} in the 28 days before.`];
    if (typeof m.ga4Sessions === "number" && typeof b.ga4Sessions === "number") {
      const way = m.ga4Sessions < b.ga4Sessions ? "down from" : m.ga4Sessions > b.ga4Sessions ? "up from" : "the same as";
      lines.push(`Google Analytics: ${n(m.ga4Sessions)} sessions started there, ${way} ${n(b.ga4Sessions)}${s.mayChange ? " (may still change a little)" : ""}.`);
    }
    return lines;
  }
  return [`${on}${n(m.searchImpressions)} impressions in the ${span(w.from, w.to)}, ${upFrom(b.searchImpressions ?? 0, s.atMost)}. Nothing on your brand map answers it yet.`];
}

/** A rising search's reason on the brand map: "410 impressions in the 14 days to 20 Nov, up from 60". */
export function proposalReason(s: Pick<DataSignal, "numbers" | "before" | "window" | "atMost">): string {
  const w = s.window;
  if (!s.numbers || !w) return "";
  return `${n(s.numbers.searchImpressions)} impressions in the ${span(w.from, w.to)}, ${upFrom(s.before?.searchImpressions ?? 0, s.atMost)}`;
}

const sameWords = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Why a question on the brand map was proposed, as its proposal line says it. One from a rising
 * Google search keeps the search's words as its evidence and their numbers as its reason; once a
 * person changes the words, the line says which search they came from.
 */
export function questionReason(q: Pick<BrandMapQuestionRecord, "from" | "text" | "evidence" | "reason">): string {
  if (q.from === "search_console") return q.evidence && !sameWords(q.evidence, q.text) ? `The search “${q.evidence}”: ${q.reason}` : q.reason;
  return q.evidence || q.reason || `Proposed by ${q.from}`;
}
