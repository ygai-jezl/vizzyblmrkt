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

/**
 * Write Idea Board items to the index under their new kind name, `idea_board`. Off: they are
 * written as `idea`, as before. Reads take both names either way, and the scheduled check moves
 * what is stored to the name in use within about 10 minutes, so turning this off is the first
 * step of a rollback.
 */
export function isSearchKindIdeaBoardEnabled(): boolean {
  return process.env.SEARCH_KIND_IDEA_BOARD_ENABLED === "true";
}

/**
 * The brand map family in the index for every brand, with statuses (ADR-0025, needs
 * SEARCH_INDEX_ENABLED): subjects and situations (decided or proposed), kept notes, the questions
 * asked of the team (asked or answered) and competitor articles, so the readers that match by
 * meaning can move off brand_map_vectors. People's search still needs brand_search, and still
 * hides proposals and answered questions. Off: the index holds what it held before, and every
 * reader uses brand_map_vectors.
 */
export function isSearchFamilyIndexEnabled(): boolean {
  return isSearchIndexEnabled() && process.env.SEARCH_FAMILY_INDEX_ENABLED === "true";
}

/**
 * Subject and situation readers (duplicate checks, nearest subjects and situations) use the index
 * only (needs SEARCH_FAMILY_INDEX_ENABLED). Off: they use brand_map_vectors, which is still written.
 */
export function isSearchSubjectReadsEnabled(): boolean {
  return isSearchFamilyIndexEnabled() && process.env.SEARCH_SUBJECT_READS_ENABLED === "true";
}

/**
 * Note and question readers (What we've seen's matching, its repeat checks, Vizzy's notes search)
 * use the index only (needs SEARCH_FAMILY_INDEX_ENABLED). A note that may name a customer isn't in
 * the index, so it is then found only through its subject link. Off: they use brand_map_vectors.
 */
export function isSearchNoteReadsEnabled(): boolean {
  return isSearchFamilyIndexEnabled() && process.env.SEARCH_NOTE_READS_ENABLED === "true";
}

/**
 * Competitor article readers (which questions no competitor covers, the articles nearest a
 * question) use the index only (needs SEARCH_FAMILY_INDEX_ENABLED). A competitor's own summary is
 * never one of them. Off: they use brand_map_vectors.
 */
export function isSearchCompetitorReadsEnabled(): boolean {
  return isSearchFamilyIndexEnabled() && process.env.SEARCH_COMPETITOR_READS_ENABLED === "true";
}

/**
 * brand_map_vectors is retired (ADR-0025): no more writes, embeddings or status updates to it, so
 * scripts/retire-old-vectors.ts can empty it. Only while all three read switches are on too (and
 * so the family and the index): with any of them off, a reader still uses the old store, and it
 * keeps being written. Removals from it keep running until the delete has run.
 */
export function isOldVectorsRetired(): boolean {
  return (
    isSearchSubjectReadsEnabled() &&
    isSearchNoteReadsEnabled() &&
    isSearchCompetitorReadsEnabled() &&
    process.env.SEARCH_OLD_VECTORS_RETIRED_ENABLED === "true"
  );
}
