import type { EmailLanguage } from "@/lib/email/emailRender";
import type { PoolItem } from "@/lib/types/lifecycle";
import { isJourneyEmailTranslation, type Translation } from "@/lib/types/translation";
import { isAssetTranslationsEnabled } from "./flags";
import { localeInfo, normalizeLocale } from "./locale";
import { getMessage } from "./messages";

/**
 * Which version of a journey email a reader gets (ASSET_TRANSLATIONS_ENABLED). One rule for both
 * runners and for the AI line's preparation:
 *
 * - the reader's own language (their sign up's or product user's), when it is in the list and is
 *   not the email's base language;
 * - and an approved translation of this email from that base;
 * - else the base, exactly as before.
 *
 * Readers of the base cost no read. Sending never asks whether the brand may make translations:
 * a brand that loses the feature keeps sending what it approved.
 */

type Words = Pick<PoolItem, "subject" | "previewText" | "body" | "layout">;

export interface EmailVersion<T> {
  item: T;
  /** Null: the base language, rendered as before. */
  language: EmailLanguage | null;
}

/** The reader's language when it may get its own version: in the list, and not the base. */
export function versionLanguage(raw: string | null | undefined, base: string, list: readonly string[]): string | null {
  const lang = normalizeLocale(raw);
  return lang && lang !== base && list.includes(lang) ? lang : null;
}

/** The fixed words an email in `lang` carries: the footer and the progress line, from the message catalog. */
export function emailLanguageFor(lang: string): EmailLanguage {
  return {
    lang,
    dir: localeInfo(lang).dir,
    footer: {
      sentBy: getMessage(lang, "email.footer.sentBy"),
      preferences: getMessage(lang, "email.footer.preferences"),
      unsubscribe: getMessage(lang, "email.footer.unsubscribe"),
      privacy: getMessage(lang, "email.footer.privacy"),
    },
    stepsDone: getMessage(lang, "email.steps.done"),
    more: getMessage(lang, "email.steps.more"),
  };
}

/**
 * The email with the approved words of `translation` in place of the base's, or null when there
 * are none from this base. An email with a block layout renders from its blocks, so it is never
 * swapped.
 */
export function withApprovedWords<T extends Words>(item: T, translation: Translation | null | undefined, base: string): T | null {
  const approved = translation && isJourneyEmailTranslation(translation) ? translation.approved : null;
  if (!approved || approved.from !== base || item.layout) return null;
  return { ...item, subject: approved.fields.subject, previewText: approved.fields.previewText, body: approved.fields.body };
}

/**
 * The version for a reader of `lang` (from versionLanguage; null = the base). Reads at most the
 * one translation record, through `load`, and only while the switch is on.
 */
export async function emailVersionFor<T extends Words>(args: {
  item: T;
  base: string;
  lang: string | null;
  load: (lang: string) => Promise<Translation | null>;
}): Promise<EmailVersion<T>> {
  if (!args.lang || !isAssetTranslationsEnabled()) return { item: args.item, language: null };
  const translation = await args.load(args.lang).catch(() => null);
  const item = withApprovedWords(args.item, translation, args.base);
  return item ? { item, language: emailLanguageFor(args.lang) } : { item: args.item, language: null };
}
