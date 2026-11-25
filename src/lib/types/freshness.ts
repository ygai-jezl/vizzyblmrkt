import type { FreshnessClock, FreshnessReason } from "./contentPlan";

/**
 * The freshness watch's record per brand (BLOG_FRESHNESS_ENABLED, src/lib/content/blog/freshnessWatch.ts),
 * `fw_<tenantId>`. Each article's own freshness lives on the article (`blog.freshness`); this keeps
 * what Review, Home, Next up, Vizzy and Search Console's rows read, so none of them reads every plan.
 */

/** A live article that is due, or soon due, a refresh. */
export interface FreshnessDueItem {
  planId: string;
  workspaceId: string;
  title: string;
  url: string;
  state: "soon" | "due";
  reasons: FreshnessReason[];
  dueAt: string;
  clockDays: FreshnessClock;
  subjectId: string | null;
}

export interface FreshnessWatchDoc {
  id: string;
  tenantId: string;
  /** When the brand is next looked at (once a day). */
  nextAt: string;
  counts: { fresh: number; soon: number; due: number };
  /** Live articles on each clock. */
  byClock: Record<"20" | "30" | "45", number>;
  /** Every live article's page, as Search Console keys pages (host and path), for matching rows. */
  pages: Array<{ key: string; planId: string; workspaceId: string }>;
  /** Due first, then soon, earliest first; at most 20. */
  due: FreshnessDueItem[];
  /** Links checked today, against the daily cap. */
  linksDay: string;
  linksToday: number;
  updatedAt: string;
  /**
   * How many times an erase took Search Console's figures out (src/lib/content/blog/freshnessErase.ts),
   * counted up by each. A look that sees it change while it runs writes none of those figures and
   * leaves the next look due soon. Missing means none yet.
   */
  searchConsoleClears?: number;
}
