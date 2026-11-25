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
  /** When the brand is next looked at: once a day, or at the next tick while a look cut short goes on. */
  nextAt: string;
  /**
   * When the look still going on began: a look its tick's time cuts short sets it, the next tick goes
   * on with the articles not looked at since, and the look that reaches the last one clears it.
   * Missing or null: no look is going on.
   */
  lookStartedAt?: string | null;
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
}
