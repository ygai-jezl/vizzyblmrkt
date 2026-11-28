/**
 * The languages the sign-up widget's own words exist in (messages/<code>.json). A launch page gets
 * an address of its own only in these (PAGE_LANGUAGES_ENABLED), so every word on it can be in that
 * language. Safe in the browser: no catalog is loaded here. messages.test.ts checks it matches.
 */
export const WIDGET_LOCALES = ["en", "fr", "es", "de", "ja", "ar"] as const;

export function hasWidgetWords(code: string): boolean {
  return (WIDGET_LOCALES as readonly string[]).includes(code);
}
