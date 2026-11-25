import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";

/**
 * The one check every reason in the learning registry passes (src/lib/loops/registry.ts): why a
 * choice learns in its own store, why it never learns, or why it doesn't learn yet. A brand owner
 * may read it, so it is one plain sentence about that choice. Pure: writingRules imports nothing.
 */

/** The shortest reason that can say something about one choice. */
export const REASON_MIN_CHARS = 30;

/** Words that stand in for a reason without giving one. */
const STOCK = [
  /\b(?:todo|tbd|fixme|lorem|xxx)\b/i,
  /\bn\/a\b/i,
  /\bsee (?:above|below)\b/i,
  /\bsame as\b/i,
  /^(?:not needed|not applicable|not relevant|no reason|nothing to learn|does not learn|doesn't learn|not yet|later|none)\b/i,
];

/** What is wrong with a reason, in plain words; empty when it is fine. */
export function reasonProblems(text: string): string[] {
  const t = text.trim();
  const out: string[] = [];
  if (t.length < REASON_MIN_CHARS) out.push(`shorter than ${REASON_MIN_CHARS} characters`);
  if (!/^[A-Za-z]/.test(t)) out.push("starts with something other than a word");
  if (!t.endsWith(".")) out.push("does not end with a full stop");
  if (/[.!?]\s+[A-Z]/.test(t.slice(0, -1))) out.push("more than one sentence");
  if (/\n/.test(t)) out.push("more than one line");
  if (STOCK.some((re) => re.test(t))) out.push("stock text, not a reason");
  for (const d of dashesIn(t)) out.push(`a dash as punctuation: ${d}`);
  for (const tell of aiTellsIn(t)) out.push(`an AI tell: ${tell}`);
  return out;
}

export function reasonOk(text: string): boolean {
  return reasonProblems(text).length === 0;
}
