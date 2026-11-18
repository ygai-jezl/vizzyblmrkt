import type { BrandSignal, SerpFindings } from "@/lib/types/brandSignal";
import { marketLabel } from "./markets";

/**
 * What a page sees of a lookup: what Google showed and the lines "Get from Google" adds to the
 * brief's What buyers ask box. Never the task id, the cost or the brand.
 */
export interface SignalView {
  id: string;
  status: BrandSignal["status"];
  query: string;
  market: string;
  readyAt: string | null;
  numbers: BrandSignal["numbers"];
  results: SerpFindings | null;
  lines: string[];
  error: string | null;
}

/** The lines for the box: each People also ask question, then also searched, related, and who the AI Overview cites. */
export function boxLines(r: SerpFindings | null): string[] {
  if (!r) return [];
  const out = r.paa.map((p) => p.question);
  if (r.alsoSearched.length) out.push(`Also searched: ${r.alsoSearched.join("; ")}`);
  if (r.related.length) out.push(`Related searches: ${r.related.join("; ")}`);
  if (r.aiOverview?.cites.length) out.push(`Google's AI Overview cites: ${[...new Set(r.aiOverview.cites.map((c) => c.domain))].join(", ")}`);
  return out;
}

export function signalView(s: BrandSignal): SignalView {
  return {
    id: s.id,
    status: s.status,
    query: s.about.query,
    market: marketLabel(s.market),
    readyAt: s.readyAt,
    numbers: s.status === "ready" ? s.numbers : null,
    results: s.status === "ready" ? s.results : null,
    lines: s.status === "ready" ? boxLines(s.results) : [],
    error: s.status === "failed" ? s.error : null,
  };
}

/** The box's text with new lines added at the end: never removes what someone typed, never adds a line twice. */
export function mergeIntoBox(current: string, lines: string[], max = 6000): { text: string; added: number } {
  const have = new Set(
    current
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );
  const fresh = lines.filter((l) => {
    const k = l.trim().toLowerCase();
    if (!k || have.has(k)) return false;
    have.add(k);
    return true;
  });
  if (!fresh.length) return { text: current, added: 0 };
  const base = current.replace(/\s+$/, "");
  let text = base;
  let added = 0;
  for (const l of fresh) {
    const next = text ? `${text}${added === 0 ? "\n\n" : "\n"}${l}` : l;
    if (next.length > max) break;
    text = next;
    added += 1;
  }
  return { text, added };
}
