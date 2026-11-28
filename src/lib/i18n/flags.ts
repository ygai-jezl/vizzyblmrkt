import { isPersonLinksEnabled } from "@/lib/audience/flags";

/**
 * Everything YouGrow writes follows the brand's default language (`tenant.defaultLocale`, set in
 * Settings › General › Languages), and the checks on articles, emails and lines read that language.
 * Off = everything is written exactly as before.
 */
export function isContentLanguageEnabled(): boolean {
  return process.env.CONTENT_LANGUAGE_ENABLED === "true";
}

/**
 * Each person's language on their record, readers counted per language, and the brand's
 * threshold for giving a language its own version (LANGUAGE_READERS_ENABLED). Launches offer the
 * brand's one language list. Needs the brand language and the person records, since readers are
 * counted from those. Off: people, launches and Settings are as before.
 */
export function isLanguageReadersEnabled(): boolean {
  return process.env.LANGUAGE_READERS_ENABLED === "true" && isContentLanguageEnabled() && isPersonLinksEnabled();
}

/**
 * Journey emails in each language with enough readers (ASSET_TRANSLATIONS_ENABLED): publishing a
 * journey has its changed emails translated, a person checks each translation, and each reader
 * gets the approved version in their language. Needs the readers per language. Each brand also
 * needs the `translations` feature (src/lib/plans/brandAccess.ts) for new translations; sending
 * what was approved never needs it. Off: journeys, sends and Review are as before.
 */
export function isAssetTranslationsEnabled(): boolean {
  return process.env.ASSET_TRANSLATIONS_ENABLED === "true" && isLanguageReadersEnabled();
}

/**
 * Pages people find by search in each language, Google's way (PAGE_LANGUAGES_ENABLED): articles get
 * a version per language at its own address with the full set of language tags, and launch pages get
 * one address per language with their own words translated. Needs the translations. Making new
 * translations still needs each brand's `translations` feature; copying and showing them don't.
 * Off: articles, launch pages and Settings are as before.
 */
export function isPageLanguagesEnabled(): boolean {
  return process.env.PAGE_LANGUAGES_ENABLED === "true" && isAssetTranslationsEnabled();
}
