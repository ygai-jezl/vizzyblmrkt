/**
 * The guard on every AI line (and AI subject). The product's own insight
 * sentence carries the numbers; the AI line may only explain or encourage, so it
 * must not smuggle in facts the product didn't give us:
 *
 *  - no digits or spelled-out quantities ("three times", "double");
 *  - no URLs, domains or email addresses; no markup or merge tokens;
 *  - no promises ("guarantee", "#1", "best in class", …);
 *  - no capitalised names (people, companies, tools) except the product, the
 *    brand, the facts' labels, the connection's glossary and anything staff
 *    attested;
 *  - a line ≤ 40 words; a subject ≤ 60 characters.
 *
 * Pure. Used when the line is written, when staff edit it, and again at send.
 */

export interface LineCheck {
  ok: boolean;
  issues: string[];
}

export const MAX_LINE_WORDS = 40;
export const MAX_SUBJECT_CHARS = 60;

const BANNED: Array<[RegExp, string]> = [
  [/\bguarantee[sd]?\b/i, "guarantee"],
  [/#\s*1\b/, "#1"],
  [/\bno\.?\s*1\b/i, "no. 1"],
  [/\bnumber one\b/i, "number one"],
  [/\bbest[- ]in[- ]class\b/i, "best in class"],
  [/\brisk[- ]free\b/i, "risk-free"],
  [/\bact now\b/i, "act now"],
  [/\blimited time\b/i, "limited time"],
  [/\bmiracle\b/i, "miracle"],
  [/\bskyrocket/i, "skyrocket"],
  [/\bdominat(e|ing)\b/i, "dominate"],
  [/\bproven to\b/i, "proven to"],
];

const QUANTITY_WORDS =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|billion|percent|twice|double|doubled|triple|tripled|half)\b/i;

const URLISH =
  /(https?:\/\/|www\.)|[^\s@]+@[^\s@]+|\b[a-z0-9-]+\.(?:com|ai|io|co|net|org|app|dev|uk|us|eu|de|fr|es|nl|xyz|info|biz|gg|me|so|tech|shop)\b/i;

/** Capitalised words that aren't names. */
const ALWAYS_OK = new Set(["i", "i'm", "i've", "i'd", "i'll", "ai"]);

/**
 * Capitalised names in the text. The first word of each sentence is skipped
 * (it's capitalised anyway) unless it's clearly a name on its own ("ChatGPT",
 * "GitHub", "SEO"); any capitalised words after it still count.
 */
export function capitalisedNames(text: string): string[] {
  const names: string[] = [];
  for (const sentence of text.split(/(?<=[.!?:;])\s+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    let run: string[] = [];
    let runStartsSentence = false;
    const flush = () => {
      // A plain capitalised first word is just the sentence start ("Ask Google"
      // → "Google"); one with inner capitals is a name ("ChatGPT", "SEO").
      const words = runStartsSentence && run.length > 0 && !/^\p{Lu}.*\p{Lu}/u.test(run[0]!) ? run.slice(1) : run;
      if (words.length) names.push(words.join(" "));
      run = [];
    };
    words.forEach((raw, i) => {
      const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const capitalised = /^\p{Lu}/u.test(w) && !ALWAYS_OK.has(w.toLowerCase());
      if (capitalised) {
        if (run.length === 0) runStartsSentence = i === 0;
        run.push(w);
        // Punctuation after a word ends the name ("Acme, Globex").
        if (/[^\p{L}\p{N}]$/u.test(raw)) flush();
      } else {
        flush();
      }
    });
    flush();
  }
  return names;
}

function nameAllowed(name: string, allowed: string[]): boolean {
  const n = name.toLowerCase();
  return allowed.some((term) => {
    const t = term.toLowerCase().trim();
    return t.length > 0 && (t.includes(n) || n.includes(t));
  });
}

function common(text: string, allowed: string[]): string[] {
  const issues: string[] = [];
  if (/\d/.test(text)) issues.push("Contains a number — numbers may only come from the product's own insight.");
  const qty = text.match(QUANTITY_WORDS);
  if (qty) issues.push(`Contains a quantity ("${qty[0]}") — numbers may only come from the product's own insight.`);
  if (URLISH.test(text)) issues.push("Contains a link, domain or email address.");
  if (/[<>]|\{\{|\}\}/.test(text)) issues.push("Contains markup or a merge token.");
  for (const [re, label] of BANNED) if (re.test(text)) issues.push(`Makes a promise ("${label}").`);
  for (const name of capitalisedNames(text)) {
    if (!nameAllowed(name, allowed)) issues.push(`Names "${name}", which isn't in the product's facts or glossary.`);
  }
  return issues;
}

export function validateAiLine(line: string, allowed: string[]): LineCheck {
  const text = line.trim();
  if (!text) return { ok: false, issues: ["The line is empty."] };
  const issues = common(text, allowed);
  const words = text.split(/\s+/).length;
  if (words > MAX_LINE_WORDS) issues.push(`Too long (${words} words; the limit is ${MAX_LINE_WORDS}).`);
  return { ok: issues.length === 0, issues };
}

export function validateAiSubject(subject: string, allowed: string[]): LineCheck {
  const text = subject.trim();
  if (!text) return { ok: false, issues: ["The subject is empty."] };
  const issues = common(text, allowed);
  if (text.length > MAX_SUBJECT_CHARS) issues.push(`Subject too long (${text.length} characters; the limit is ${MAX_SUBJECT_CHARS}).`);
  return { ok: issues.length === 0, issues };
}
