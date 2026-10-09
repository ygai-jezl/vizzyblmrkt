/**
 * Cite sources. A knowledge source that carries the `cite` tag is one an article may
 * CITE: a study, a report, a page of data. Blog research reads these alongside its web
 * search and offers the writer checked facts from both.
 *
 * A cite source on SOMEONE ELSE'S site is evidence — what a third party found. It is
 * never the brand's own material: everything else that reads the knowledge base (posts,
 * emails, Vizzy, the fact check's idea of what the brand says) leaves it out. A cite
 * source on the brand's own site — its own research — can be cited just the same, and
 * stays the brand's material as well, like any other page of it.
 *
 * It is an ordinary tag on purpose: a tag is already stamped on every passage of a source
 * and already has its vector index, so nothing new is stored and nothing is migrated.
 * Pure + client-safe.
 */
export const CITE_TAG = "cite";

/** The most tags a source may carry (the normalizer's cap). */
const MAX_TAGS = 20;

/**
 * Server flag. On: a web source can be marked a cite source (and read as one page),
 * blog research reads cite sources next to its web search, a cite source on someone
 * else's site is kept out of the brand's own material, and research checks whether the
 * publisher's robots.txt keeps AI crawlers out. Off: none of that happens.
 */
export function isCiteSourcesEnabled(): boolean {
  return process.env.CREATE_BLOG_CITE_SOURCES_ENABLED === "true";
}

/** Client mirror — the "cite source" controls on a knowledge source and on the brief. */
export function isCiteSourcesUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BLOG_CITE_SOURCES_ENABLED === "true";
}

export function isCiteSource(tags: readonly string[] | null | undefined): boolean {
  return Array.isArray(tags) && tags.includes(CITE_TAG);
}

/** The tags with `cite` added (first, so the cap can never push it out) or taken away. */
export function withCiteTag(tags: readonly string[] | null | undefined, on: boolean): string[] {
  const rest = (tags ?? []).filter((t) => t !== CITE_TAG);
  return on ? [CITE_TAG, ...rest].slice(0, MAX_TAGS) : rest;
}

/** A source that is a page (or pages) on the web, not a code repo. Only these can be cited. */
export function isWebSource(source: string | null | undefined): boolean {
  return source === "docs_url" || source === "website";
}
