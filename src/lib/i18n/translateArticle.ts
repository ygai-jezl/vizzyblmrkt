import { generateJsonWithSchema, parseFirstJson, type AiUsage } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { stampDateLine } from "@/lib/content/blog/draft";
import { articleLabel, type ArticleLabel } from "@/lib/content/blog/labels";
import { headingIds } from "@/lib/content/blog/markdown";
import { outlineArticle } from "@/lib/content/blog/outline";
import type { ArticleWords } from "@/lib/types/translation";
import { languageName } from "./locale";
import { getMessage } from "./messages";
import { linksOf } from "./translate";

/**
 * One approved article into one other language (PAGE_LANGUAGES_ENABLED): one structured call, then
 * code puts the date line back in the target language, points in-page links at the new heading
 * ids, checks the result (boxes, FAQ, sections, sources, links, lengths) and adds the translated
 * note when the brand wants it. A failed check asks once more when there is time; otherwise the
 * translation fails with its reason. Nothing here reads or writes data.
 */

/** An article is long: a call gets this long, and the lane starts one only with this much time left. */
export const ARTICLE_TRANSLATE_TIMEOUT_MS = 80_000;

const KEYS = ["metaTitle", "metaDescription", "heroAlt", "body"] as const;
type Key = (typeof KEYS)[number];
const LIMITS: Record<Key, number> = { metaTitle: 200, metaDescription: 400, heroAlt: 300, body: 30000 };
const NAMES: Record<Key, string> = { metaTitle: "title", metaDescription: "description", heroAlt: "image alt text", body: "article" };

/** The box and section labels a writer uses; the date line's are put back by code. */
const LABELS: ArticleLabel[] = ["keyFacts", "tldr", "answer", "tip", "faq", "nextStep", "keyTakeaways", "bottomLine", "sources", "aboutAuthor"];

export interface ArticleTranslateInput {
  words: ArticleWords;
  /** Base codes, like "en" and "fr". */
  from: string;
  to: string;
  glossary: readonly string[];
  /** The byline on the date line, when the article has one there. */
  author: { name: string; role: string | null } | null;
  /** Add "Translated from the original and checked by our team." in the target language. */
  note: boolean;
  usage: AiUsage;
  /** No second try unless one more call fits before this. */
  deadlineMs?: number;
}

export type ArticleTranslateResult = { ok: true; fields: ArticleWords; tries: number } | { ok: false; reason: string; tries: number };

export interface ArticleTranslateDeps {
  generate?: typeof generateJsonWithSchema;
  now?: () => number;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    strings: {
      type: "array",
      items: { type: "object", properties: { key: { type: "string", enum: [...KEYS] }, text: { type: "string" } }, required: ["key", "text"] },
    },
  },
  required: ["strings"],
};

/** Code writes the date line: the model sees a marker in its place, and keeps it there. */
const DATE_MARKER = "{{date_line}}";

/** The source's date line, the one under the title holding its "Last updated" day. */
function dateLineIndex(lines: string[], date: string | null): number {
  if (!date) return -1;
  const firstSection = lines.findIndex((l) => /^##\s+\S/.test(l));
  return lines.findIndex((l, i) => (firstSection === -1 || i < firstSection) && l.includes(date) && /^\s*[*_]/.test(l));
}

/** The body as the model sees it: the date line swapped for its marker. */
export function withDateMarker(body: string): string {
  const lines = body.split("\n");
  const at = dateLineIndex(lines, outlineArticle(body).lastUpdated);
  if (at === -1) return body;
  lines[at] = DATE_MARKER;
  return lines.join("\n");
}

function stringsOf(words: ArticleWords): Array<{ key: Key; text: string }> {
  return KEYS.filter((k) => words[k].trim()).map((key) => ({ key, text: key === "body" ? withDateMarker(words.body) : words[key] }));
}

/** Each label as the source writes it and as the target must, so the boxes stay findable. */
function labelPairs(from: string, to: string): string {
  return `Write these box and section labels exactly as given here: ${LABELS.map((k) => `"${articleLabel(from, k)}" as "${articleLabel(to, k)}"`).join("; ")}.`;
}

function promptFor(input: ArticleTranslateInput, problems: readonly string[]): string {
  const glossary = input.glossary.map((g) => g.trim()).filter(Boolean);
  return renderPrompt("i18n.translate_article", {
    from_language: languageName(input.from),
    to_language: languageName(input.to),
    glossary: glossary.length ? glossary.map((g) => `"${g}"`).join(", ") : "none given",
    label_directive: labelPairs(input.from, input.to),
    strings: JSON.stringify(stringsOf(input.words)),
    problems: problems.length ? `\nYour last answer had these problems. Fix every one:\n${problems.map((p) => `- ${p}`).join("\n")}\n` : "",
  });
}

function answerOf(raw: string | null): Partial<Record<Key, string>> | null {
  if (!raw) return null;
  const parsed = parseFirstJson(raw) as { strings?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.strings)) return null;
  const out: Partial<Record<Key, string>> = {};
  for (const entry of parsed.strings) {
    const { key, text } = (entry ?? {}) as { key?: unknown; text?: unknown };
    if (typeof key === "string" && (KEYS as readonly string[]).includes(key) && typeof text === "string" && out[key as Key] === undefined) out[key as Key] = text;
  }
  return out;
}

/** In-page links (#id) follow their heading: the n-th heading's old id becomes its new one. */
export function remapAnchors(source: string, translated: string): string {
  const from = headingIds(source);
  const to = headingIds(translated);
  if (from.length !== to.length || !from.length) return translated;
  const map = new Map(from.map((id, i) => [id, to[i]!]));
  return translated.replace(/\]\(#([^)\s]+)\)/g, (m, id: string) => (map.has(id) ? `](#${map.get(id)})` : m));
}

/**
 * The date line written again in the target language where the model kept its marker, with the
 * byline when the source had one. Null when the source had a date line and the marker was lost.
 */
function restampDateLine(source: string, translated: string, to: string, author: ArticleTranslateInput["author"]): string | null {
  const date = outlineArticle(source).lastUpdated;
  const lines = source.split("\n");
  const at = dateLineIndex(lines, date);
  if (at === -1 || !date) return translated;
  if (!translated.includes(DATE_MARKER)) return null;
  const hadByline = /\d{4}-\d{2}-\d{2}\s*·/.test(lines[at]!);
  const byline = hadByline && author?.name ? `${articleLabel(to, "by", { name: author.name })}${author.role ? `, ${author.role}` : ""}` : "";
  const stamp = `*${articleLabel(to, "lastUpdated")}: ${date}*`;
  // stampDateLine replaces the line it finds, so the marker becomes a plain date line first.
  return stampDateLine(translated.replace(/^.*\{\{date_line\}\}.*$/m, stamp), date, byline, to);
}

const sameCount = (a: readonly unknown[] | null, b: readonly unknown[] | null) => (a?.length ?? -1) === (b?.length ?? -1);
const outward = (links: string[]) => links.filter((l) => !l.startsWith("#")).sort();

/** What is wrong with a translation of `source`, in plain words for the repair try and the tab. */
export function articleProblems(source: ArticleWords, out: Partial<Record<Key, string>>): string[] {
  const problems: string[] = [];
  for (const key of KEYS) {
    if (!source[key].trim()) continue;
    const got = out[key];
    if (got == null || !got.trim()) {
      problems.push(`The ${NAMES[key]} is missing or empty.`);
      continue;
    }
    const cap = key === "body" ? Math.min(LIMITS.body, Math.max(source.body.length * 1.8, source.body.length + 2000)) : LIMITS[key];
    if (got.length > cap) problems.push(`The ${NAMES[key]} is much longer than the original.`);
  }
  const body = out.body ?? "";
  if (!body.trim()) return problems;
  if (outward(linksOf(source.body)).join("\n") !== outward(linksOf(body)).join("\n")) problems.push("The article changed, added or lost a link.");
  const a = outlineArticle(source.body);
  const b = outlineArticle(body);
  if (a.title && !b.title) problems.push("The article lost its title heading.");
  if (!sameCount(a.keyFacts, b.keyFacts) || !sameCount(a.tldr, b.tldr)) problems.push("A box (key facts or summary) was lost or changed its number of items.");
  if (a.faq.length !== b.faq.length) problems.push("The article has a different number of questions in its FAQ.");
  if (a.sections.length !== b.sections.length) problems.push("The article has a different number of sections.");
  if (!sameCount(a.sources, b.sources)) problems.push("The sources list was lost or changed its number of items.");
  return problems;
}

/** Translate the article, put its fixed parts back, check it, and ask once more when there is time. */
export async function translateArticle(input: ArticleTranslateInput, deps: ArticleTranslateDeps = {}): Promise<ArticleTranslateResult> {
  const generate = deps.generate ?? generateJsonWithSchema;
  const clock = deps.now ?? Date.now;
  let problems: string[] = [];
  let reason = "The translation could not be checked.";
  let tries = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt === 2 && input.deadlineMs !== undefined && input.deadlineMs - clock() < ARTICLE_TRANSLATE_TIMEOUT_MS) break;
    tries = attempt;
    const raw = await generate(promptFor(input, problems), { schema: SCHEMA, timeoutMs: ARTICLE_TRANSLATE_TIMEOUT_MS, temperature: 0.2, thinkingBudget: 0, usage: input.usage });
    if (!raw) {
      problems = [];
      reason = "No answer came back in time.";
      continue;
    }
    const answer = answerOf(raw);
    if (!answer) {
      problems = ["The answer was not the JSON asked for."];
      reason = problems[0]!;
      continue;
    }
    const stamped = answer.body ? restampDateLine(input.words.body, remapAnchors(input.words.body, answer.body), input.to, input.author) : answer.body;
    const body = stamped ?? answer.body;
    const shaped = { ...answer, body };
    problems = [...(stamped === null ? ["The article lost its date line marker {{date_line}}."] : []), ...articleProblems(input.words, shaped)];
    if (problems.length === 0) {
      const note = input.note ? `\n\n*${getMessage(input.to, "article.translatedNote")}*\n` : "";
      return {
        ok: true,
        tries,
        fields: {
          metaTitle: shaped.metaTitle ?? "",
          metaDescription: shaped.metaDescription ?? "",
          heroAlt: input.words.heroAlt.trim() ? (shaped.heroAlt ?? "") : "",
          body: `${body!.trimEnd()}${note || "\n"}`,
        },
      };
    }
    reason = problems[0]!;
  }
  return { ok: false, tries, reason };
}
