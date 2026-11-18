import type { BrandSignal, JudgedItem, SerpFindings } from "@/lib/types/brandSignal";
import { marketLabel } from "./markets";

/**
 * What a page sees of a lookup: what Google showed, what the judge kept for the article, and the
 * lines "Get from Google" adds to What buyers ask. Never the task id, the cost or the brand.
 */
export interface SignalView {
  id: string;
  status: BrandSignal["status"];
  query: string;
  market: string;
  readyAt: string | null;
  numbers: BrandSignal["numbers"];
  results: SerpFindings | null;
  /** Whether the judge has checked the results. Nothing is added until it has. */
  judged: boolean;
  lines: string[];
  /** What the judge left out, and why. */
  leftOut: Array<Pick<JudgedItem, "text" | "verdict" | "reason">>;
  error: string | null;
}

/** The items to use, and the ones left out with why. Without a judgement, nothing is used. Pure (the browser loads this file). */
export function splitJudged(sig: Pick<BrandSignal, "judged">): { use: JudgedItem[]; leftOut: JudgedItem[] } {
  const items = sig.judged?.items ?? [];
  return { use: items.filter((i) => i.verdict === "use"), leftOut: items.filter((i) => i.verdict !== "use") };
}

/** The lines for the box: each question the judge kept, then the kept "people also search for" on one line. */
export function boxLines(use: JudgedItem[]): string[] {
  const out = use.filter((i) => i.kind === "paa").map((i) => i.text);
  const also = use.filter((i) => i.kind === "also").map((i) => i.text);
  if (also.length) out.push(`Also searched: ${also.join("; ")}`);
  return out;
}

export function signalView(s: BrandSignal): SignalView {
  const ready = s.status === "ready";
  const { use, leftOut } = splitJudged(s);
  return {
    id: s.id,
    status: s.status,
    query: s.about.query,
    market: marketLabel(s.market),
    readyAt: s.readyAt,
    numbers: ready ? s.numbers : null,
    results: ready ? s.results : null,
    judged: ready && Boolean(s.judged),
    lines: ready ? boxLines(use) : [],
    leftOut: ready ? leftOut.map(({ text, verdict, reason }) => ({ text, verdict, reason })) : [],
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
