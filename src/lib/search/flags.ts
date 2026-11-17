/**
 * Flags for brand search: one index per brand that finds what the brand wrote by its words and
 * by its meaning, in a separate Firestore Enterprise database per region (search, search-eu,
 * search-asia; `npm run selfhost -- --apply addon:search` creates them). Each is off unless
 * "true": listed "false" in apphosting.yaml and turned on per deployment. Off: nothing is
 * embedded, written or searched, and the app behaves as before.
 */

/** Keep the index: write on save, remove on delete, the scheduled check and the backfill script. */
export function isSearchIndexEnabled(): boolean {
  return process.env.SEARCH_INDEX_ENABLED === "true";
}

/** The search API that reads the index (needs SEARCH_INDEX_ENABLED). */
export function isSearchEnabled(): boolean {
  return isSearchIndexEnabled() && process.env.SEARCH_ENABLED === "true";
}

/**
 * Reorder the merged results with Google's Ranking API (needs SEARCH_ENABLED). US brands only:
 * the Ranking API runs in the `global` and `us` locations, so an EU or Asia brand's text would
 * leave its region.
 */
export function isSearchRerankEnabled(): boolean {
  return isSearchEnabled() && process.env.SEARCH_RERANK_ENABLED === "true";
}

/** Client mirror (build-time): the Search panel (Ctrl K) and the Search card in Settings. */
export function isSearchUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SEARCH_ENABLED === "true";
}

/** Vizzy's search_brand tool (needs SEARCH_ENABLED). */
export function isVizzySearchEnabled(): boolean {
  return isSearchEnabled() && process.env.VIZZY_SEARCH_ENABLED === "true";
}
