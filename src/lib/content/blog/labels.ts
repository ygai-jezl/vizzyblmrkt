import { DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale } from "@/lib/i18n/locale";
import { getMessage } from "@/lib/i18n/messages";

/**
 * The fixed words a blog article carries: its boxes (Key facts, TL;DR, Answer, Tip), its fixed
 * sections (Frequently asked questions, Next step, The bottom line, Sources, About the author) and
 * its date line (Last updated, Published, Updated, By). They are in the message catalog as
 * `article.*`, so an article written in another language (CONTENT_LANGUAGE_ENABLED) carries them in
 * that language. A language with no catalog file keeps the English words.
 *
 * Code that reads an article accepts the English words as before, plus every other catalog
 * language's (`otherLabels`), so it never needs to know which language an article is in.
 */
export const ARTICLE_LABELS = [
  "lastUpdated",
  "published",
  "updated",
  "by",
  "keyFacts",
  "tldr",
  "answer",
  "tip",
  "faq",
  "nextStep",
  "keyTakeaways",
  "bottomLine",
  "sources",
  "aboutAuthor",
] as const;
export type ArticleLabel = (typeof ARTICLE_LABELS)[number];

/** A label in `language` (English when the language has no catalog file). */
export function articleLabel(language: string | null | undefined, key: ArticleLabel, vars?: Record<string, string>): string {
  return getMessage(language, `article.${key}`, vars);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

/** Which label a box or section's words are, in any catalog language; null for words of the writer's own. */
export function labelKeyOf(text: string): ArticleLabel | null {
  const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s:：]+$/u, "").trim();
  const want = fold(text);
  if (!want) return null;
  for (const key of ARTICLE_LABELS) {
    if (fold(articleLabel(DEFAULT_LOCALE, key)) === want || otherLabels(key).some((w) => fold(w) === want)) return key;
  }
  return null;
}

/** Each catalog language's word for a label, other than English's (deduped). */
export function otherLabels(key: ArticleLabel): string[] {
  const en = articleLabel(DEFAULT_LOCALE, key).toLowerCase();
  const out = new Set<string>();
  for (const code of SUPPORTED_LOCALES) {
    const word = articleLabel(code, key);
    if (word.toLowerCase() !== en) out.add(word);
  }
  return [...out];
}

/** The other languages' words for these labels, as one regex alternation ("" when there are none). */
function alternation(keys: ArticleLabel[]): string {
  return [...new Set(keys.flatMap(otherLabels))]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|");
}

/** Where a label may end: the end, a space, punctuation or the close of bold. Works for any script. */
const ENDS = "(?=$|[\\s:：.。!?！？*،])";

/**
 * `english` (the pattern code has always used) or, at the start, any other language's word for
 * `keys`. With `whole`, the other words must be the whole text. Flags stay as `english` has them.
 */
export function withOtherLanguages(english: RegExp, keys: ArticleLabel[], opts: { prefix?: string; whole?: boolean } = {}): RegExp {
  const alt = alternation(keys);
  if (!alt) return english;
  const tail = opts.whole ? "\\s*$" : ENDS;
  return new RegExp(`${english.source}|^${opts.prefix ?? ""}(?:${alt})${tail}`, english.flags);
}

/** True when a line is (or opens with) another language's date line label, such as "Dernière mise à jour". */
export const OTHER_DATE_LINE = new RegExp(`^\\W*(?:${alternation(["lastUpdated"]) || "(?!)"})${ENDS}`, "iu");

/** Every line holding another language's date line label, for taking date lines out of text (use with replace, not test). */
export const OTHER_DATE_LINES = new RegExp(`^.*(?:${alternation(["lastUpdated"]) || "(?!)"}).*$`, "gimu");

/** The language whose "Last updated" word opens this line ("en" when it is English's or none). */
export function dateLineLanguage(text: string): string {
  const line = text.replace(/^[\s*_>]+/, "").toLowerCase();
  for (const code of SUPPORTED_LOCALES) {
    if (code === DEFAULT_LOCALE) continue;
    const word = articleLabel(code, "lastUpdated").toLowerCase();
    if (word !== articleLabel(DEFAULT_LOCALE, "lastUpdated").toLowerCase() && line.startsWith(word)) return code;
  }
  return DEFAULT_LOCALE;
}

/** The labels the blog writer is told to use, in the order its prompts name them. */
const WRITER_LABELS: ArticleLabel[] = ["lastUpdated", "keyFacts", "tldr", "answer", "tip", "keyTakeaways", "faq", "nextStep", "bottomLine", "sources"];

/**
 * What the blog writer is told about its fixed labels in `language`: the word to use for each
 * English one its prompt names, or, for a language with no catalog file, to keep the English
 * ones (so code still finds the boxes and sections). "" for English.
 */
export function articleLabelDirective(language: string | null | undefined): string {
  const norm = normalizeLocale(language);
  if (!norm || norm === DEFAULT_LOCALE) return "";
  const pairs = WRITER_LABELS.map((key) => [articleLabel(DEFAULT_LOCALE, key), articleLabel(norm, key)] as const);
  const changed = pairs.filter(([en, local]) => en !== local);
  if (!changed.length) {
    return `Keep these box and section labels exactly as the instructions above write them, in English: ${pairs.map(([en]) => `"${en}"`).join(", ")}.`;
  }
  return `Write these box and section labels as given here, in place of the English ones the instructions above use: ${pairs
    .map(([en, local]) => `"${en}" as "${local}"`)
    .join("; ")}.`;
}
