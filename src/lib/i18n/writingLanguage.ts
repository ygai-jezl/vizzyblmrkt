import type { AiUsage } from "@/lib/agents/gemini";
import { isContentLanguageEnabled } from "./flags";
import { DEFAULT_LOCALE, normalizeLocale, writingDirective } from "./locale";

/**
 * The language YouGrow writes a brand's copy in (CONTENT_LANGUAGE_ENABLED): the brand's default
 * language from Settings › General › Languages (`tenant.defaultLocale`). With the switch off, or
 * nothing set, it is English and every prompt is exactly what it was.
 *
 * Writers get it from the call's usage (`AiUsage.brandLanguage`, built from the brand in
 * src/lib/plans/meter.ts), so no function between a route and its writer needs a new argument.
 * Only prompts whose words a person reads get it. Ones that extract, judge, classify, read a page
 * or brief the image model are left as they are; src/lib/i18n/writingLanguage.guard.test.ts lists
 * both kinds.
 */

/** The writing language for a brand record: its default with the switch on, else English. Pure. */
export function writingLanguageOf(tenant: { defaultLocale?: string | null } | null | undefined): string {
  if (!isContentLanguageEnabled()) return DEFAULT_LOCALE;
  return normalizeLocale(tenant?.defaultLocale) ?? DEFAULT_LOCALE;
}

/** The writing language for one model call, from its usage. English when the switch is off, the usage can't say, or the read fails. */
export async function writingLanguage(usage: Pick<AiUsage, "brandLanguage"> | null | undefined): Promise<string> {
  if (!isContentLanguageEnabled() || !usage?.brandLanguage) return DEFAULT_LOCALE;
  try {
    return normalizeLocale(await usage.brandLanguage()) ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * `prompt` with the writing sentence for `language` after it, then `extra` (an article's section
 * labels, say). Unchanged for English. Pure.
 */
export function withWritingLanguage(prompt: string, language: string, extra = ""): string {
  const directive = writingDirective(language);
  if (!directive) return prompt;
  return `${prompt}\n\n${[directive, extra.trim()].filter(Boolean).join("\n")}`;
}

/** A writer's prompt in the brand's language: `withWritingLanguage` with the language from the call's usage. */
export async function inBrandLanguage(
  prompt: string,
  usage: Pick<AiUsage, "brandLanguage"> | null | undefined,
  extra?: (language: string) => string,
): Promise<string> {
  const language = await writingLanguage(usage);
  return withWritingLanguage(prompt, language, extra ? extra(language) : "");
}

/** True for a language other than English (the checks that read English words skip it). */
export function isNotEnglish(language: string | null | undefined): boolean {
  const norm = normalizeLocale(language);
  return !!norm && norm !== DEFAULT_LOCALE;
}
