/**
 * Flags for the brand map. Each ships "true" in dev (apphosting.yaml) and an explicit
 * "false" in prod (apphosting.prod.yaml) until it has been checked on dev and promoted.
 * Every one needs the record itself (BRAND_MAP_ENABLED). Server flags are read at
 * runtime; pages pass what is on to their client components. The one NEXT_PUBLIC mirror
 * only shows the Brand map tile. Off: nothing reads or writes a brand map, and articles
 * are written exactly as before.
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
