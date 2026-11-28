import { generateJsonWithSchema, parseFirstJson, type AiUsage } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import type { LaunchWords } from "@/lib/types/translation";
import { languageName } from "./locale";
import { TRANSLATE_TIMEOUT_MS, tokensOf } from "./translate";

/**
 * A launch page's own words into one other language (PAGE_LANGUAGES_ENABLED): one structured call,
 * every string by key, then checks in code. One repair try, then failed with its reason.
 */

export interface LaunchTranslateInput {
  words: LaunchWords;
  from: string;
  to: string;
  glossary: readonly string[];
  usage: AiUsage;
}

export type LaunchTranslateResult = { ok: true; fields: LaunchWords; tries: number } | { ok: false; reason: string; tries: number };

const LIMIT = { waitlistName: 200, statusDescription: 1000, joinButtonLabel: 120, introLine: 600, question: 500, answer: 300 } as const;

/** Every string of the page's words, each with a key: q0 is the first question, q0a1 its second answer. */
export function launchStrings(w: LaunchWords): Array<{ key: string; text: string; max: number }> {
  const out: Array<{ key: string; text: string; max: number }> = [];
  const add = (key: string, text: string | null, max: number) => {
    if (text?.trim()) out.push({ key, text, max });
  };
  add("waitlistName", w.waitlistName, LIMIT.waitlistName);
  add("statusDescription", w.statusDescription, LIMIT.statusDescription);
  add("joinButtonLabel", w.joinButtonLabel, LIMIT.joinButtonLabel);
  add("introLine", w.introLine, LIMIT.introLine);
  w.questions.forEach((q, i) => {
    add(`q${i}`, q.question, LIMIT.question);
    (q.answers ?? []).forEach((a, j) => add(`q${i}a${j}`, a, LIMIT.answer));
  });
  return out;
}

/** The words with each string replaced by its translation; answers keep their order. */
function rebuild(w: LaunchWords, got: Record<string, string>): LaunchWords {
  const t = (key: string, text: string | null) => (text?.trim() ? (got[key] ?? text) : text);
  return {
    waitlistName: t("waitlistName", w.waitlistName) ?? w.waitlistName,
    statusDescription: t("statusDescription", w.statusDescription),
    joinButtonLabel: t("joinButtonLabel", w.joinButtonLabel),
    introLine: t("introLine", w.introLine),
    questions: w.questions.map((q, i) => ({
      question: t(`q${i}`, q.question) ?? q.question,
      answers: q.answers ? q.answers.map((a, j) => t(`q${i}a${j}`, a) ?? a) : null,
    })),
  };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function launchProblems(w: LaunchWords, got: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const s of launchStrings(w)) {
    const text = got[s.key];
    if (text == null || !text.trim()) {
      problems.push(`The string "${s.key}" is missing or empty.`);
      continue;
    }
    if (text.length > s.max) problems.push(`The string "${s.key}" is longer than ${s.max} characters.`);
    if (!same(tokensOf(s.text), tokensOf(text))) problems.push(`The string "${s.key}" changed or lost a merge token in double braces.`);
  }
  // Answer options must stay different from each other, or a person can't tell them apart.
  w.questions.forEach((q, i) => {
    const answers = (q.answers ?? []).map((_, j) => got[`q${i}a${j}`] ?? "");
    if (answers.length && new Set(answers.map((a) => a.trim().toLowerCase())).size !== answers.length) problems.push(`The answers to question q${i} are no longer all different.`);
  });
  return problems;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { strings: { type: "array", items: { type: "object", properties: { key: { type: "string" }, text: { type: "string" } }, required: ["key", "text"] } } },
  required: ["strings"],
};

export async function translateLaunch(input: LaunchTranslateInput, deps: { generate?: typeof generateJsonWithSchema } = {}): Promise<LaunchTranslateResult> {
  const generate = deps.generate ?? generateJsonWithSchema;
  const strings = launchStrings(input.words).map(({ key, text }) => ({ key, text }));
  const glossary = input.glossary.map((g) => g.trim()).filter(Boolean);
  let problems: string[] = [];
  let reason = "The translation could not be checked.";
  for (let tries = 1; tries <= 2; tries += 1) {
    const raw = await generate(
      renderPrompt("i18n.translate_launch", {
        from_language: languageName(input.from),
        to_language: languageName(input.to),
        glossary: glossary.length ? glossary.map((g) => `"${g}"`).join(", ") : "none given",
        strings: JSON.stringify(strings),
        problems: problems.length ? `\nYour last answer had these problems. Fix every one:\n${problems.map((p) => `- ${p}`).join("\n")}\n` : "",
      }),
      { schema: SCHEMA, timeoutMs: TRANSLATE_TIMEOUT_MS, temperature: 0.2, thinkingBudget: 0, usage: input.usage },
    );
    if (!raw) {
      problems = [];
      reason = "No answer came back in time.";
      continue;
    }
    const parsed = parseFirstJson(raw) as { strings?: unknown } | null;
    const got: Record<string, string> = {};
    for (const e of Array.isArray(parsed?.strings) ? parsed!.strings : []) {
      const { key, text } = (e ?? {}) as { key?: unknown; text?: unknown };
      if (typeof key === "string" && typeof text === "string" && got[key] === undefined) got[key] = text;
    }
    problems = launchProblems(input.words, got);
    if (!problems.length) return { ok: true, tries, fields: rebuild(input.words, got) };
    reason = problems[0]!;
  }
  return { ok: false, tries: 2, reason };
}
