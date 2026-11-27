import { generateJsonWithSchema, parseFirstJson, type AiUsage } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { aiUsage } from "@/lib/plans/meter";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import type { EmailWords } from "@/lib/types/translation";
import { languageName } from "./locale";

/**
 * One journey email into one other language (ASSET_TRANSLATIONS_ENABLED): one structured call,
 * then checks in code. A failed check asks once more with the problems; a second failure is a
 * failed translation with its reason. It never loops. Nothing here reads or writes data.
 */

/** A long body takes a while to translate; the tick starts a call only with this much time left. */
export const TRANSLATE_TIMEOUT_MS = 45_000;
const LIMITS = { subject: 200, previewText: 200, body: 20000 } as const;
type Key = keyof typeof LIMITS;

export interface TranslateInput {
  words: EmailWords;
  /** Base codes, like "en" and "fr". */
  from: string;
  to: string;
  /** Names that must not change: the brand, its products. */
  glossary: readonly string[];
  usage: AiUsage;
}

export type TranslateResult = { ok: true; fields: EmailWords; tries: number } | { ok: false; reason: string; tries: number };

export interface TranslateDeps {
  generate?: typeof generateJsonWithSchema;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    strings: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string", enum: Object.keys(LIMITS) }, text: { type: "string" } },
        required: ["key", "text"],
      },
    },
  },
  required: ["strings"],
};

/** The strings to translate: the subject, the preview text when there is one, and the body. */
function stringsOf(words: EmailWords): Array<{ key: Key; text: string }> {
  const out: Array<{ key: Key; text: string }> = [{ key: "subject", text: words.subject }];
  if (words.previewText?.trim()) out.push({ key: "previewText", text: words.previewText });
  out.push({ key: "body", text: words.body });
  return out;
}

/** Each merge token as its field name and whether it has a fallback: the fallback words may change. */
export function tokensOf(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)]
    .map((m) => {
      const [key, ...rest] = m[1]!.split("|");
      return `${key!.trim()}${rest.length ? "|" : ""}`;
    })
    .sort();
}

/** Every link target and web address, in order of appearance, then sorted. */
export function linksOf(text: string): string[] {
  const hrefs = [...text.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]!.trim());
  const markdown = [...text.matchAll(/\]\(\s*([^)\s]+)\s*\)/g)].map((m) => m[1]!);
  const bare = [...text.replace(/\bhref\s*=\s*["'][^"']*["']/gi, "").replace(/\]\(\s*[^)\s]+\s*\)/g, "").matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) =>
    m[0].replace(/[.,;:!?]+$/, ""),
  );
  return [...hrefs, ...markdown, ...bare].sort();
}

/** Headings and list items, in HTML or Markdown. */
export function shapeOf(text: string): { headings: number; items: number } {
  const headings = (text.match(/<h[1-6][\s>]/gi) ?? []).length + (text.match(/^\s{0,3}#{1,6}\s/gm) ?? []).length;
  const items = (text.match(/<li[\s>]/gi) ?? []).length + (text.match(/^\s*(?:[-*+]|\d+[.)])\s+\S/gm) ?? []).length;
  return { headings, items };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** What is wrong with a translation of `source`, in plain words for the repair try and the tab. */
export function problemsWith(source: EmailWords, answer: Partial<Record<Key, string | null>>): string[] {
  const problems: string[] = [];
  for (const { key, text } of stringsOf(source)) {
    const name = key === "previewText" ? "preview text" : key;
    const got = answer[key];
    if (got == null || !got.trim()) {
      problems.push(`The ${name} is missing or empty.`);
      continue;
    }
    if (got.length > LIMITS[key]) problems.push(`The ${name} is longer than ${LIMITS[key]} characters.`);
    if (!same(tokensOf(text), tokensOf(got))) problems.push(`The ${name} changed or lost a merge token in double braces.`);
    if (!same(linksOf(text), linksOf(got))) problems.push(`The ${name} changed, added or lost a link.`);
    const a = shapeOf(text);
    const b = shapeOf(got);
    if (a.headings !== b.headings || a.items !== b.items) problems.push(`The ${name} has a different number of headings or list items.`);
  }
  return problems;
}

function promptFor(input: TranslateInput, problems: readonly string[]): string {
  const glossary = input.glossary.map((g) => g.trim()).filter(Boolean);
  return renderPrompt("i18n.translate_email", {
    from_language: languageName(input.from),
    to_language: languageName(input.to),
    glossary: glossary.length ? glossary.map((g) => `"${g}"`).join(", ") : "none given",
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
    if (typeof key === "string" && key in LIMITS && typeof text === "string" && out[key as Key] === undefined) out[key as Key] = text;
  }
  return out;
}

/** Translate the email, check it, and ask once more with the problems when the check fails. */
export async function translateEmail(input: TranslateInput, deps: TranslateDeps = {}): Promise<TranslateResult> {
  const generate = deps.generate ?? generateJsonWithSchema;
  let problems: string[] = [];
  let reason = "The translation could not be checked.";
  for (let tries = 1; tries <= 2; tries += 1) {
    const raw = await generate(promptFor(input, problems), { schema: SCHEMA, timeoutMs: TRANSLATE_TIMEOUT_MS, temperature: 0.2, thinkingBudget: 0, usage: input.usage });
    if (!raw) {
      // Nothing came back (a timeout or an error): ask again as it was.
      problems = [];
      reason = "No answer came back in time.";
      continue;
    }
    const answer = answerOf(raw);
    problems = answer ? problemsWith(input.words, answer) : ["The answer was not the JSON asked for."];
    if (answer && problems.length === 0) {
      return {
        ok: true,
        tries,
        fields: { subject: answer.subject!, previewText: input.words.previewText?.trim() ? answer.previewText! : input.words.previewText, body: answer.body! },
      };
    }
    reason = problems[0]!;
  }
  return { ok: false, tries: 2, reason };
}

/** The meter for one translation call: its tokens count as "translation". */
export function translationUsage(ctx: Pick<TenantContext, "tenantId" | "region">, tenant?: Tenant | null): AiUsage {
  return aiUsage(ctx, "translation", { tenant });
}
