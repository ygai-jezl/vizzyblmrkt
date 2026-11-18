/**
 * Brand signals: outside numbers about a brand, kept for planning (src/lib/signals).
 *
 * - BRAND_SIGNALS_ENABLED: the store, its scheduled collecting, and the Search market setting.
 * - SIGNALS_DATAFORSEO_ENABLED (needs the first): Google's results for a question through
 *   DataForSEO, and the "Get from Google" button. Needs DATAFORSEO_USERNAME and
 *   DATAFORSEO_PASSWORD, and per brand the `next_up` feature (src/lib/plans/brandAccess.ts).
 */
export function isBrandSignalsEnabled(): boolean {
  return process.env.BRAND_SIGNALS_ENABLED === "true";
}

export function isSignalsDataForSeoEnabled(): boolean {
  return isBrandSignalsEnabled() && process.env.SIGNALS_DATAFORSEO_ENABLED === "true";
}
