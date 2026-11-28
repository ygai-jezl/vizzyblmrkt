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

/** A draft and an approved version of some words, whatever they are. */
const draftOf = <T extends z.ZodTypeAny>(fields: T) =>
  z.object({
    fields,
    sourceHash: z.string(),
    by: z.enum(["ai", "person"]),
    at: z.string(),
  });
const approvedOf = <T extends z.ZodTypeAny>(fields: T) =>
  draftOf(fields).extend({
    /** The default language it was translated from: it is used only while that is still the base. */
    from: z.string(),
    approvedBy: z.string(),
    approvedAt: z.string(),
  });

export const TranslationDraftSchema = draftOf(EmailWordsSchema);
export type TranslationDraft = z.infer<typeof TranslationDraftSchema>;
export const ApprovedTranslationSchema = approvedOf(EmailWordsSchema);
export type ApprovedTranslation = z.infer<typeof ApprovedTranslationSchema>;

/** What every kind keeps. */
const common = {
  id: z.string(),
  tenantId: z.string(),
  lang: z.string(),
  from: z.string(),
  state: z.enum(TRANSLATION_STATES),
  rev: z.number().int().nonnegative(),
  sourceHash: z.string(),
  failReason: z.string().max(300).nullable(),
  /** A tick working on it holds it until then (ISO time). */
  leaseUntil: z.string().nullable(),
  /** Made though under the threshold (Make anyway): queued again like the others. */
  anyway: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

/** A journey email in another language (piece 2). Its source words are the published version's. */
export const JourneyEmailTranslationSchema = z.object({
  ...common,
  kind: z.literal("journey_email"),
  journeyId: z.string(),
  poolId: z.string(),
  itemId: z.string(),
  draft: TranslationDraftSchema.nullable(),
  approved: ApprovedTranslationSchema.nullable(),
});
export type JourneyEmailTranslation = z.infer<typeof JourneyEmailTranslationSchema>;

/**
 * An article's words (PAGE_LANGUAGES_ENABLED): its title, description and hero alt text, and the
 * Markdown body. A translation may run longer than the 20,000 characters of a default body.
 */
export const ArticleWordsSchema = z.object({
  metaTitle: z.string().max(200),
  metaDescription: z.string().max(400),
  heroAlt: z.string().max(300),
  body: z.string().max(30000),
});
export type ArticleWords = z.infer<typeof ArticleWordsSchema>;
export const ArticleDraftSchema = draftOf(ArticleWordsSchema);
export const ApprovedArticleSchema = approvedOf(ArticleWordsSchema);

/** Where a version was found live, and the return links its page was missing then. */
export const VersionLiveSchema = z.object({
  url: z.string().max(2000),
  at: z.string(),
  checkedAt: z.string(),
  /** Languages (and "x-default") the page's tags don't list, so Google may ignore the whole set. */
  missingTags: z.array(z.string().max(20)).max(30),
});
export type VersionLive = z.infer<typeof VersionLiveSchema>;

/**
 * An article in another language. `source` is the default article's words as approved when this was
 * queued, so the lane never reads the plan, and a later edit can't change what is being translated.
 */
export const ArticleTranslationSchema = z.object({
  ...common,
  kind: z.literal("article"),
  workspaceId: z.string(),
  planId: z.string(),
  nodeId: z.string(),
  source: ArticleWordsSchema,
  draft: ArticleDraftSchema.nullable(),
  approved: ApprovedArticleSchema.nullable(),
  /** This version's address on the brand's site: the language's folder and the slug, unless changed. */
  address: z.string().max(2000).nullable(),
  /** Set by Found live once this version is seen at its address. */
  live: VersionLiveSchema.nullable(),
});
export type ArticleTranslation = z.infer<typeof ArticleTranslationSchema>;

/** A launch page's own words (PAGE_LANGUAGES_ENABLED): everything on it that the brand wrote. */
export const LaunchWordsSchema = z.object({
  waitlistName: z.string().max(200),
  statusDescription: z.string().max(1000).nullable(),
  joinButtonLabel: z.string().max(120).nullable(),
  introLine: z.string().max(600).nullable(),
  /** Each question and its answer options, in the launch's order. */
  questions: z.array(z.object({ question: z.string().max(500), answers: z.array(z.string().max(300)).max(50).nullable() })).max(30),
});
export type LaunchWords = z.infer<typeof LaunchWordsSchema>;
export const LaunchDraftSchema = draftOf(LaunchWordsSchema);
export const ApprovedLaunchSchema = approvedOf(LaunchWordsSchema);

/** A launch page's words in another language, from its words as saved when this was queued. */
export const LaunchCopyTranslationSchema = z.object({
  ...common,
  kind: z.literal("launch_copy"),
  campaignId: z.string(),
  source: LaunchWordsSchema,
  draft: LaunchDraftSchema.nullable(),
  approved: ApprovedLaunchSchema.nullable(),
});
export type LaunchCopyTranslation = z.infer<typeof LaunchCopyTranslationSchema>;

export const TranslationSchema = z.discriminatedUnion("kind", [JourneyEmailTranslationSchema, ArticleTranslationSchema, LaunchCopyTranslationSchema]);
export type Translation = z.infer<typeof TranslationSchema>;
export type TranslationKind = Translation["kind"];

export const isJourneyEmailTranslation = (t: Translation): t is JourneyEmailTranslation => t.kind === "journey_email";
export const isArticleTranslation = (t: Translation): t is ArticleTranslation => t.kind === "article";
export const isLaunchCopyTranslation = (t: Translation): t is LaunchCopyTranslation => t.kind === "launch_copy";

/** The record's id: one per journey email and language. Ids are slugs, so `_` is a safe join. */
export function translationIdOf(journeyId: string, poolId: string, itemId: string, lang: string): string {
  return `tr_${journeyId}_${poolId}_${itemId}_${lang}`;
}

/** An article version's record: one per article and language. */
export function articleTranslationIdOf(planId: string, nodeId: string, lang: string): string {
  return `tra_${planId}_${nodeId}_${lang}`;
}

/** A launch page's words in one language. */
export function launchTranslationIdOf(campaignId: string, lang: string): string {
  return `trl_${campaignId}_${lang}`;
}
