import { z } from "zod";

/**
 * One journey email in one other language (ASSET_TRANSLATIONS_ENABLED), in the `translations`
 * collection (src/lib/tenant/translations.ts). Doc id `tr_<journeyId>_<poolId>_<itemId>_<lang>`.
 *
 * - `sourceHash` is the hash of the default language words this record should match: the words
 *   last published. When the published words change, the record is queued again.
 * - `draft` is the newest translation, waiting for a person (`to_check`), from a model or a
 *   person's own edit.
 * - `approved` is what readers of `lang` get. It stays until a newer draft is approved, even after
 *   the default words change: readers keep the last approved translation meanwhile.
 * - `rev` goes up on every change a person could have seen, so an approve names what was shown.
 */
export const TRANSLATION_STATES = ["queued", "to_check", "approved", "failed"] as const;
export type TranslationState = (typeof TRANSLATION_STATES)[number];

/** The words of a journey email that are translated. Everything else stays the default's. */
export const EmailWordsSchema = z.object({
  subject: z.string().max(200),
  previewText: z.string().max(200).nullable(),
  body: z.string().max(20000),
});
export type EmailWords = z.infer<typeof EmailWordsSchema>;

export const TranslationDraftSchema = z.object({
  fields: EmailWordsSchema,
  sourceHash: z.string(),
  by: z.enum(["ai", "person"]),
  at: z.string(),
});
export type TranslationDraft = z.infer<typeof TranslationDraftSchema>;

export const ApprovedTranslationSchema = TranslationDraftSchema.extend({
  /** The default language it was translated from: a send swaps only when this is still the base. */
  from: z.string(),
  approvedBy: z.string(),
  approvedAt: z.string(),
});
export type ApprovedTranslation = z.infer<typeof ApprovedTranslationSchema>;

export const TranslationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  kind: z.literal("journey_email"),
  journeyId: z.string(),
  poolId: z.string(),
  itemId: z.string(),
  lang: z.string(),
  from: z.string(),
  state: z.enum(TRANSLATION_STATES),
  rev: z.number().int().nonnegative(),
  sourceHash: z.string(),
  draft: TranslationDraftSchema.nullable(),
  approved: ApprovedTranslationSchema.nullable(),
  failReason: z.string().max(300).nullable(),
  /** A tick working on it holds it until then (ISO time). */
  leaseUntil: z.string().nullable(),
  /** Made though under the threshold (Make anyway): queued again on publish like the others. */
  anyway: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Translation = z.infer<typeof TranslationSchema>;

/** The record's id: one per journey email and language. Ids are slugs, so `_` is a safe join. */
export function translationIdOf(journeyId: string, poolId: string, itemId: string, lang: string): string {
  return `tr_${journeyId}_${poolId}_${itemId}_${lang}`;
}
