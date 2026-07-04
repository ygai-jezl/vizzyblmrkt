/**
 * Deterministic email critics — a lightweight "Critic Agent" pass the copywriter runs
 * over its own output before it lands on the canvas. No LLM, no dependencies:
 *
 *  - spamScan()          → flags deliverability-hostile phrasing/formatting (warn-only,
 *                          plus one safe auto-fix: collapse runs of "!" to a single "!").
 *  - fleschKincaidGrade() → approximate US reading grade; the caller warns when the copy
 *                          reads above ~8th grade (sales/marketing email should be 3rd-5th).
 *
 * Pure + framework-agnostic; surfaced as node `warnings[]` alongside `unfilled_tokens`.
 */

/** Multi-word spam-trigger phrases (bare words like "free" are intentionally NOT here —
 *  "free shipping" is legitimate incentive copy — only the classic spammy collocations). */
const SPAM_PHRASES: { re: RegExp; note: string }[] = [
  { re: /\b100%\s*free\b/i, note: "100% free" },
  { re: /\bfree\s+cash\b/i, note: "free cash" },
  { re: /\bbuy\s+now\b/i, note: "buy now" },
  { re: /\bact\s+now\b/i, note: "act now" },
  { re: /\bclick\s+here\b/i, note: "click here" },
  { re: /\brisk[-\s]?free\b/i, note: "risk-free" },
  { re: /\bcash\s+bonus\b/i, note: "cash bonus" },
  { re: /\bmake\s+money\s+fast\b/i, note: "make money fast" },
  { re: /\blimited\s+time\s+only\b/i, note: "limited time only" },
  { re: /\bonce\s+in\s+a\s+lifetime\b/i, note: "once in a lifetime" },
];

/** Common legitimate 4+-letter acronyms that shouldn't read as shouting. */
const CAPS_ALLOW = new Set([
  "HTML",
  "HTTP",
  "HTTPS",
  "JSON",
  "TERMS",
  "SAAS",
  "FAQS",
  "DEMO",
  "BETA",
  "NASA",
  "IKEA",
]);

/** Strip light HTML so critics see the reader-visible text. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Collapse runs of "!" (2+) to a single "!" — the one safe auto-correction. */
export function collapseBangs(s: string): string {
  return s.replace(/!{2,}/g, "!");
}

function looksSpammy(text: string): boolean {
  const visible = stripHtml(text);
  if (SPAM_PHRASES.some((p) => p.re.test(visible))) return true;
  if (/!{3,}/.test(text)) return true; // 3+ exclamation marks
  if (/\${3,}/.test(text)) return true; // $$$ money spam
  // Shouting = several 4+-letter ALL-CAPS words. Common acronyms are allow-listed so
  // legitimate B2B copy ("SAAS boosts ROI", "read the FAQ", "NASA + IKEA") doesn't trip.
  const caps = (visible.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !CAPS_ALLOW.has(w));
  if (caps.length >= 3) return true;
  return false;
}

export interface SpamScanResult {
  warnings: string[]; // "spam_subject" | "spam_body"
  cleanedSubject: string;
  cleanedBody: string;
}

/** Flag spammy subject/body and apply the safe auto-fix (bang collapse). */
export function spamScan(subject: string, body: string): SpamScanResult {
  const warnings: string[] = [];
  if (subject && looksSpammy(subject)) warnings.push("spam_subject");
  if (body && looksSpammy(body)) warnings.push("spam_body");
  return {
    warnings,
    cleanedSubject: collapseBangs(subject),
    cleanedBody: collapseBangs(body),
  };
}

/** Rough syllable estimate for one word (vowel-group count, drop silent trailing e). */
function syllablesIn(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 0;
  if (w.endsWith("e") && n > 1) n -= 1; // silent 'e'
  return Math.max(1, n);
}

/**
 * Flesch–Kincaid grade level (approximate). Returns 0 for empty/degenerate input so the
 * caller never warns on nothing.
 */
export function fleschKincaidGrade(text: string): number {
  const visible = stripHtml(text);
  if (!visible) return 0;
  const sentences = Math.max(1, (visible.match(/[.!?]+/g) ?? []).length);
  const words = visible.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  if (words.length === 0) return 0;
  const syllables = words.reduce((sum, w) => sum + syllablesIn(w), 0);
  const grade = 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
  return Math.round(grade * 10) / 10;
}

/** The grade above which marketing-email copy is flagged as too complex. */
export const READABILITY_MAX_GRADE = 8;
