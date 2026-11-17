/**
 * Flags for Competitors (Brand › Competitors): another business's website a brand watches. We
 * read its sitemap once as a baseline, learn how the site is built, then check its news page
 * every week and the whole sitemap every month. Each is off unless "true": listed "false" in
 * apphosting.yaml and turned on per deployment. Off: nothing is fetched, read or written.
 */

/** The page, its APIs and the weekly and monthly checks (which ride the lifecycle tick). */
export function isCompetitorsEnabled(): boolean {
  return process.env.COMPETITORS_ENABLED === "true";
}

/** Client mirror (build-time): the tile on the Brand page and Monitor on the brand map's alternatives. */
export function isCompetitorsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COMPETITORS_ENABLED === "true";
}

/** Vizzy reads the competitors and what changed (it never starts watching one). */
export function isCompetitorsChatEnabled(): boolean {
  return isCompetitorsEnabled() && process.env.COMPETITORS_CHAT_ENABLED === "true";
}

/**
 * Read a site that turns automated readers away (a bot screen in front of it) through Google
 * instead: Gemini's URL reader fetches their robots.txt and sitemap files from Google's side. News
 * only, and it costs model calls on every check. Off: such a site says it can't be read.
 */
export function isCompetitorsGoogleReaderEnabled(): boolean {
  return isCompetitorsEnabled() && process.env.COMPETITORS_GOOGLE_READER_ENABLED === "true";
}
