/**
 * Found live's working state (BLOG_LIVE_WATCH_ENABLED, src/lib/content/blog/liveWatch.ts), one
 * pair of records per brand. What it finds lives on the article itself (its live mark), never here.
 */

/** An address saved on an article, checked every few hours for two weeks. */
export interface LiveWatchAddress {
  url: string;
  /** First checked at this address (a new address starts again). */
  firstAt: string;
  nextAt: string;
  checks: number;
  /** How much of the article was on the page at the last check, 0 to 1. */
  textShare: number | null;
}

/** `lw_<tenantId>`: when the brand is next due, and what it is doing. */
export interface LiveWatchDoc {
  id: string;
  tenantId: string;
  nextAt: string;
  /** When the sitemap is next read (only while articles wait with no address). */
  sitemapNextAt: string | null;
  /** The site last read, and its sitemaps (found once, kept while the site stays the same). */
  site: string;
  sitemaps: string[];
  /** Sitemap files not reached yet (a read spread over passes). */
  queue: string[];
  addresses: Record<string, LiveWatchAddress>;
  /** The last thing that went wrong, as a code ("no_sitemap", "turned_away", "unreachable"). */
  lastError: string | null;
  updatedAt: string;
}

/** `lws_<tenantId>`: pages already opened, as "<hash of the page>\t<its lastmod day>" lines, newest last. */
export interface LiveWatchSeen {
  id: string;
  tenantId: string;
  lines: string[];
  updatedAt: string;
}
