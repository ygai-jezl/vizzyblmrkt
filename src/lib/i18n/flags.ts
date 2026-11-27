/**
 * Everything YouGrow writes follows the brand's default language (`tenant.defaultLocale`, set in
 * Settings › General › Languages), and the checks on articles, emails and lines read that language.
 * Off = everything is written exactly as before.
 */
export function isContentLanguageEnabled(): boolean {
  return process.env.CONTENT_LANGUAGE_ENABLED === "true";
}
