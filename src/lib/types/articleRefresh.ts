import type { BlogArticleDates } from "./contentPlan";

/**
 * Article refresh (BLOG_REFRESH_ENABLED): an article's earlier versions, its review, and the record
 * of each review that the clock readout learns from. Each lives in its own store, read by id, so
 * the plan doc (which holds every node) stays the size it was.
 */

/** Why a version was kept: just before Apply, Regenerate or Restore changed the copy. */
export type VersionReason = "apply" | "regenerate" | "restore";

/** One earlier version of a blog article: its copy and the meta that goes with it. */
export interface ArticleVersion {
  /** 1, 2, 3 and on, per article; never reused, so "Version 4" means one thing. */
  n: number;
  at: string;
  reason: VersionReason;
  /** Who made the change that replaced it (null: the autopilot or a scheduled step). */
  byUid: string | null;
  body: string;
  metaTitle: string;
  metaDescription: string;
  slug: string;
  /** The fact check's last run on this copy (null: not checked). */
  checkedAt: string | null;
  /** The article's Updated as it was with this copy, put back by Restore. */
  updated: BlogArticleDates["updated"] | null;
}

/** `av_<planId>`: a blog article's last versions, newest first. */
export interface ArticleVersionsDoc {
  id: string;
  tenantId: string;
  planId: string;
  workspaceId: string;
  /** The number the next version gets. */
  next: number;
  versions: ArticleVersion[];
  updatedAt: string;
}
