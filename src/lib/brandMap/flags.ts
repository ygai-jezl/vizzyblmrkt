/**
 * Flags for the brand map. Each is off unless "true": listed "false" in apphosting.yaml
 * and turned on per deployment. Every one needs the record itself (BRAND_MAP_ENABLED).
 * Server flags are read at runtime; pages pass what is on to their client components. The
 * NEXT_PUBLIC mirrors only show the Brand map tile and a step on its help page. Off: nothing
 * reads or writes a brand map, and articles are written exactly as before.
 */

/** The record, the Brand map page and saving it. */
export function isBrandMapEnabled(): boolean {
  return process.env.BRAND_MAP_ENABLED === "true";
}

/** Client mirror (build-time): the Brand map tile on the Brand page. */
export function isBrandMapUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_MAP_ENABLED === "true";
}

/** Research that drafts the map: one search-grounded model call, and a fetch of the brand's home page. */
export function isBrandMapResearchEnabled(): boolean {
  return isBrandMapEnabled() && process.env.BRAND_MAP_RESEARCH_ENABLED === "true";
}

/** Identifier lookups: sends the name being looked up to www.wikidata.org, and nothing else. */
export function isBrandMapWikidataEnabled(): boolean {
  return isBrandMapEnabled() && process.env.BRAND_MAP_WIKIDATA_ENABLED === "true";
}

/** Vizzy reads the map and files suggestions for it (never changes what is decided). */
export function isBrandMapChatEnabled(): boolean {
  return isBrandMapEnabled() && process.env.BRAND_MAP_CHAT_ENABLED === "true";
}

/** An article's address and live check, a row per page, coverage, "Write this next" and the content map. */
export function isBrandMapPagesEnabled(): boolean {
  return isBrandMapEnabled() && process.env.BRAND_MAP_PAGES_ENABLED === "true";
}

/**
 * The map at any size: subjects and their questions move out of the one record into their
 * own (once per brand, on its first write), in groups, with no fixed count; the Subjects and
 * Who you are tabs, the content map by levels, coverage by subject, and articles reading only
 * the part of the map close to them.
 */
export function isBrandMapScaleEnabled(): boolean {
  return isBrandMapEnabled() && process.env.BRAND_MAP_SCALE_ENABLED === "true";
}

/** Buying situations: research that finds them and what people in them ask, their tab, and an article's situation. */
export function isBrandMapSituationsEnabled(): boolean {
  return isBrandMapScaleEnabled() && process.env.BRAND_MAP_SITUATIONS_ENABLED === "true";
}

/**
 * "Find what they ask" on one buying situation on the map: research's second step for it (the
 * questions people in it ask), its questions added or dismissed in its panel. Uses research.
 */
export function isBrandMapSituationAskEnabled(): boolean {
  return isBrandMapSituationsEnabled() && isBrandMapResearchEnabled() && process.env.BRAND_MAP_SITUATION_ASK_ENABLED === "true";
}

/** Client mirror (build-time): the step on the Brand map help page. */
export function isBrandMapSituationAskUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRAND_MAP_SITUATION_ASK_ENABLED === "true";
}

/** The brand's own research from a PDF: sends the uploaded file to Gemini to read, keeps only what it found. */
export function isBrandMapImportEnabled(): boolean {
  return isBrandMapScaleEnabled() && process.env.BRAND_MAP_IMPORT_ENABLED === "true";
}
