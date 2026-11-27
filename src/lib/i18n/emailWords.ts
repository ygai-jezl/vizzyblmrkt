import { createHash } from "node:crypto";
import type { PoolItem } from "@/lib/types/lifecycle";
import type { EmailWords } from "@/lib/types/translation";

/**
 * The words of a journey email that get translated (ASSET_TRANSLATIONS_ENABLED), and their hash.
 * Only the words count: changing an email's format, class or eligibility translates nothing.
 */

/** The translatable words of an email. */
export function wordsOf(item: Pick<PoolItem, "subject" | "previewText" | "body">): EmailWords {
  return { subject: item.subject, previewText: item.previewText ?? null, body: item.body };
}

/** A short hash of the words, to tell whether a translation still matches them. */
export function wordsHash(words: EmailWords): string {
  return createHash("sha256")
    .update([words.subject, words.previewText ?? "", words.body].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Whether the email can be translated today. An email with a block layout renders from its blocks,
 * not its body, and no journey screen makes one, so it stays in the default language.
 */
export function isTranslatable(item: Pick<PoolItem, "layout">): boolean {
  return !item.layout;
}
