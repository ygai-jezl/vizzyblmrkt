import { generateTextWithDeadline, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { articleFigures, figureSet, normalizeFigure } from "@/lib/content/blog/figures";
import { stripFenceDelimiters } from "@/lib/content/create/siteText";
import { ChartSchema, type Chart, type ChartPoint, type Figure } from "@/lib/types/imageStyle";

/**
 * Data story's numbers and Type poster's one big number, taken from the copy (BRAND_IMAGE_STYLE_
 * MORE_ENABLED). A model proposes a chart; code keeps only what the copy really says:
 *  - every value is a number written in the text (as the fact check reads numbers: "4,235",
 *    "42%", "$1.2m" all count by their digits), and never one the fact check flagged;
 *  - every label is words from the text (a month may be short or long: "Sep", "September");
 *  - a source is kept only if the text names it.
 * Fewer than two points left gives null, and the caller asks the person or steps down. Numbers a
 * person types are theirs and never pass through here.
 */

const MAX_TEXT = 6000;
const TIMEOUT_MS = 10_000;

export interface CopyText {
  /** The post's text, or the article (plus its checked source facts). Markdown is fine. */
  text: string;
  /** Figures the fact check couldn't trace (meta.unsupportedFigures): never drawn. */
  excluded?: string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** A month as a whole word, short or long ("may" is left out: it's also a verb). */
const MONTH_WORDS = new Set([
  ...MONTHS.filter((m) => m !== "may"),
  "sept",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
]);

/** Lowercase, plain spaces and quotes, months cut to three letters. */
function plain(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”"']/g, "")
    .replace(/\b(january|february|march|april|june|july|august|september|october|november|december|sept)\b/g, (m) =>
      m.slice(0, 3),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** The numbers the fact check couldn't trace, as cores ("42%" → "42"). */
function excludedCores(excluded: string[] = []): Set<string> {
  return new Set(excluded.flatMap((e) => articleFigures(e).map((f) => f.core)));
}

/** A label the text says: its words appear in order (case, quotes and month length aside). */
export function labelInText(label: string, text: string): boolean {
  const l = plain(label);
  if (!l) return false;
  if (plain(text).includes(l)) return true;
  // "10 Sep" from "September 10": the same day and month in either order.
  const m = /^(\d{1,2}) ([a-z]{3})$/.exec(l) ?? /^([a-z]{3}) (\d{1,2})$/.exec(l);
  if (m) {
    const [day, month] = /^\d/.test(m[1]!) ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
    if (MONTHS.includes(month)) {
      const t = plain(text);
      return t.includes(`${day} ${month}`) || t.includes(`${month} ${day}`);
    }
  }
  return false;
}

/**
 * Keep only the points the text supports; drop a display the text doesn't write. Null when
 * fewer than two remain.
 */
export function verifyChart(chart: Chart, copy: CopyText): Chart | null {
  const text = copy.text ?? "";
  const numbers = figureSet(text);
  const banned = excludedCores(copy.excluded);
  const plainText = plain(text);
  const seen = new Set<string>();
  const points: ChartPoint[] = [];
  for (const p of chart.points) {
    const core = normalizeFigure(String(p.value));
    if (!numbers.has(core) || banned.has(core)) continue;
    if (!labelInText(p.label, text)) continue;
    const key = `${plain(p.label)}|${core}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const display = p.display && plainText.includes(plain(p.display)) ? p.display : undefined;
    points.push({ label: p.label.trim(), value: p.value, ...(display ? { display } : {}) });
  }
  if (points.length < 2) return null;
  const highlight = chart.highlight !== undefined && chart.highlight < points.length ? chart.highlight : undefined;
  const source = chart.source && plainText.includes(plain(chart.source)) ? chart.source.trim() : undefined;
  const kind = chart.kind === "compare" && points.length !== 2 ? "bar" : chart.kind;
  return ChartSchema.parse({ kind, unit: chart.unit, points: points.slice(0, 12), ...(highlight !== undefined ? { highlight } : {}), ...(source ? { source } : {}) });
}

export interface ChartDeps {
  generate: (prompt: string) => Promise<string | null>;
}

const defaultDeps: ChartDeps = {
  generate: (prompt) => generateTextWithDeadline(prompt, { timeoutMs: TIMEOUT_MS, json: true }),
};

/** A chart from the copy, checked; null when the copy doesn't hold two comparable numbers. */
export async function chartFromCopy(copy: CopyText, deps: ChartDeps = defaultDeps): Promise<Chart | null> {
  const text = (copy.text ?? "").slice(0, MAX_TEXT);
  if (figureSet(text).size < 2) return null;
  const raw = await deps
    .generate(renderPrompt("content.chart_from_copy", { copy: stripFenceDelimiters(text) }))
    .catch(() => null);
  if (!raw) return null;
  const json = parseFirstJson(raw);
  if (!json || typeof json !== "object" || (json as { none?: unknown }).none) return null;
  const parsed = ChartSchema.safeParse(json);
  return parsed.success ? verifyChart(parsed.data, { ...copy, text }) : null;
}

/**
 * Type poster's big number: the first figure the copy states as a fact (a unit, a currency, a
 * thousands separator or 10 and up, as the fact check reads them), with the word after it as
 * its unit. Never one the fact check flagged. No model.
 */
export function figureFromCopy(copy: CopyText): Figure | null {
  const banned = excludedCores(copy.excluded);
  const text = copy.text ?? "";
  for (const f of articleFigures(text)) {
    if (banned.has(f.core)) continue;
    // A bare year dates something; it isn't the point.
    if (/^\d{4}$/.test(f.display) && Number(f.display) >= 1900 && Number(f.display) <= 2100) continue;
    const at = text.indexOf(f.display);
    const after = at >= 0 ? text.slice(at + f.display.length, at + f.display.length + 30) : "";
    const word = /^\s([A-Za-z][A-Za-z-]{1,23})\b/.exec(after)?.[1] ?? "";
    // A day of a month ("10 Sep", "September 28") dates something too.
    const before = at >= 0 ? (/([A-Za-z]{3,9})\s$/.exec(text.slice(Math.max(0, at - 12), at))?.[1] ?? "") : "";
    if ([word, before].some((w) => MONTH_WORDS.has(w.toLowerCase()))) continue;
    const unitInDisplay = /[%x×]$|million|billion|thousand|k$|m$|bn$/i.test(f.display);
    return { value: f.display.slice(0, 14), unit: unitInDisplay ? "" : word.toLowerCase() };
  }
  return null;
}
