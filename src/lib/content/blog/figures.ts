/**
 * Figures — the numbers a blog article states. An answer engine will only quote a
 * statistic it can trace, and a reader should never meet one the brand cannot back, so
 * every figure in the copy is checked against the text the writer was given (the
 * brand's own knowledge, the operator's proof, the checked sources). The same check
 * decides whether a researched source really says what search claimed it says.
 *
 * It is a tripwire, not a proof: it catches a number that appears from nowhere; it does
 * not know that "40 customers" and "40%" are different claims. Pure + client-safe.
 */

/** A number, with its thousands separators and decimals. */
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const UNIT_AFTER = /^\s?(%|percent\b|per\s+cent\b|x\b|×|k\b|m\b|bn\b|b\b|million\b|billion\b|trillion\b|thousand\b)/i;
const CURRENCY_BEFORE = /[$€£¥]\s?$/;

/** "2,300" → "2300"; "2.0" → "2"; "14.20" → "14.2". */
export function normalizeFigure(raw: string): string {
  let s = raw.replace(/,/g, "");
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s.replace(/^0+(?=\d)/, "");
}

/** Every number in a text, normalized — the set a claimed figure must be found in. */
export function figureSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(NUMBER)) out.add(normalizeFigure(m[0]));
  return out;
}

export interface Figure {
  /** As written, with its unit ("$1.2 billion", "45%", "4x"). */
  display: string;
  /** The normalized number alone. */
  core: string;
}

/** Take out what holds digits but states nothing: code, link targets, the "Last
 *  updated" line, list numbering and ISO dates. */
function stripNonClaims(markdown: string): string {
  return (markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, " ") // fenced code
    .replace(/`[^`\n]+`/g, " ") // inline code
    .replace(/\]\(\s*<?(?:[^()\s<>]|\([^()\s]*\))+>?(?:\s+"[^"]*")?\s*\)/g, "]") // [text](url) → [text]
    .replace(/https?:\/\/[^\s)>\]]+/gi, " ")
    .replace(/^.*\blast\s+updated\b.*$/gim, " ")
    .replace(/^\s*(?:>\s*)*\d{1,3}[.)]\s+/gm, " ") // "1. " list numbering
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
}

/** "tools like Gemini 2.5" — a number straight after a name, mid-sentence, is part of
 *  the name (a version, a model, a month's year), not a claim. */
function followsAName(text: string, start: number): boolean {
  const m = /(^|[^.!?\n]\s)([A-Z][\w.'-]*)\s$/.exec(text.slice(Math.max(0, start - 48), start));
  return Boolean(m && /[a-z,;:)\]]\s$/.test(m[1] ?? ""));
}

/**
 * The figures an article states as facts: anything with a currency or a unit (%, x,
 * million…), any decimal or thousands-separated number, and any whole number from 10 up.
 * Bare single digits ("3 steps") are left alone — they are almost always counting, not
 * claiming — and so is a number that is part of a word or a name ("B2B", "24/7", "2nd",
 * "Gemini 2.5"). `ignoreYears` are years the article may use freely (the current year).
 */
export function articleFigures(markdown: string, opts: { ignoreYears?: number[] } = {}): Figure[] {
  const text = stripNonClaims(markdown);
  const ignore = new Set((opts.ignoreYears ?? []).map(String));
  const seen = new Set<string>();
  const out: Figure[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const end = start + raw.length;
    const prev = text[start - 1] ?? "";
    const next = text[end] ?? "";
    if (/[A-Za-z_]/.test(prev)) continue; // B2B, H2, v1.2
    if (prev === "/" || (next === "/" && /\d/.test(text[end + 1] ?? ""))) continue; // 24/7
    const unit = UNIT_AFTER.exec(text.slice(end, end + 12))?.[0] ?? "";
    if (!unit && /[A-Za-z_]/.test(next)) continue; // 2nd, 3D
    const currency = CURRENCY_BEFORE.exec(text.slice(Math.max(0, start - 2), start))?.[0] ?? "";
    const core = normalizeFigure(raw);
    const whole = /^\d+$/.test(raw);
    if (!unit && !currency) {
      if (whole && Number(raw) < 10) continue;
      if (whole && ignore.has(core)) continue;
      if (followsAName(text, start)) continue;
    }
    const display = `${currency.trim()}${raw}${unit}`.trim();
    if (seen.has(display)) continue;
    seen.add(display);
    out.push({ display, core });
  }
  return out;
}

/** The figures in `markdown` that appear nowhere in `reference`, as written. */
export function unsupportedFigures(
  markdown: string,
  reference: string,
  opts: { ignoreYears?: number[] } = {},
): string[] {
  const known = figureSet(reference);
  return articleFigures(markdown, opts)
    .filter((f) => !known.has(f.core))
    .map((f) => f.display);
}

/**
 * Does `pageText` hold every figure `fact` states? False when the fact states no figure
 * at all — a claim with nothing to check is not a verified claim.
 */
export function factFiguresOnPage(fact: string, pageText: string): boolean {
  const cores = [...figureSet(fact)];
  if (cores.length === 0) return false;
  const page = figureSet(pageText);
  return cores.every((c) => page.has(c));
}
