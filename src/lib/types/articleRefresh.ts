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

// ---- The review (article_reviews/ar_<planId>) --------------------------------------------------

/** A review's steps, in order. Each is short and safe to run again. */
export const REVIEW_STEPS = ["read", "sources", "research", "brand", "propose"] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

/** running: steps left; ready: proposals wait for a person; nothing: no change worth making. */
export type ReviewState = "running" | "ready" | "nothing" | "applied" | "dismissed" | "failed" | "stopped";
export type ReviewBy = "person" | "autopilot" | "vizzy";

export type EvidenceKind =
  | "dead_link"
  | "source_moved"
  | "source_changed"
  | "new_fact"
  | "new_question"
  | "open_question"
  | "page_search"
  | "product_fact"
  | "note";

/** One thing a review found, that a proposal can point to. */
export interface ReviewEvidence {
  /** "e1", "e2"… in the order found. */
  id: string;
  kind: EvidenceKind;
  /** The finding in words: a fact, a question, a search, a note. */
  text: string;
  url: string | null;
  year: number | null;
  /** More about it: a publisher, where a page moved to, a search's numbers. */
  detail: string;
}

export const PROPOSAL_KINDS = ["newer_figure", "answer_search", "new_question", "product_fact", "note", "dead_source", "source_link"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** One change a review proposes. Code checked it before anyone sees it. */
export interface ReviewProposal {
  /** "p1", "p2"… */
  id: string;
  kind: ProposalKind;
  /** The words it replaces, exactly as in the article; null for a new section. */
  old: string | null;
  new: string;
  /** For a new section: the H2 it goes after (null: before the closing sections). */
  after: string | null;
  evidenceIds: string[];
  why: string;
  /** The words change, not just a link: applying it is a real update, and moves Updated. */
  real: boolean;
  /** Ticked to start with (a weaker match starts unticked). */
  ticked: boolean;
  /** Its kind and evidence, so a dismissed change is never proposed again. */
  fingerprint: string;
  /** A source it cites, added to the brief on Apply so the fact check keeps its link. */
  source: { url: string; title: string; publisher: string; year: number | null; fact: string } | null;
}

export interface ArticleReviewDoc {
  id: string;
  tenantId: string;
  planId: string;
  workspaceId: string;
  nodeId: string;
  /** This review's own id (rv_…), for its record; a plan's next review gets a new one. */
  reviewId: string;
  by: ReviewBy;
  byUid: string | null;
  /** The next step to take; null once the review has finished. */
  step: ReviewStep | null;
  state: ReviewState;
  active: boolean;
  nextAt: string;
  leaseId: string | null;
  leaseUntil: string | null;
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  /** YYYY-MM it started, against the monthly cap. */
  month: string;
  /** Why it ran: the article's freshness when it started. */
  why: { state: "fresh" | "soon" | "due" | null; clockDays: number | null; arm: "test" | "fixed" | null; reasons: string[]; dueAt: string | null; waitedDays: number | null };
  /** What step 1 read, so later steps and Apply know the copy it looked at. */
  reading: { bodyHash: string; headings: string[]; figures: string[]; links: string[]; liveUrl: string } | null;
  evidence: ReviewEvidence[];
  /** What couldn't be looked at, said once each ("Search Console isn't shared…"). */
  notes: string[];
  proposals: ReviewProposal[];
  /** Fingerprints of changes people dismissed on this article: never proposed again. */
  dismissed: string[];
  /** What it spent, from the usage meter's own counts. */
  spent: { searches: number; tokens: number };
  error: string | null;
}

// ---- The record of each review (refresh_records/rr_<reviewId>) --------------------------------

/** Search Console's numbers for an article's page over 28 days. */
export interface PageWindow {
  clicks: number;
  impressions: number;
  /** Average position, weighted by impressions; null with no impressions. */
  position: number | null;
}

/**
 * One review, what came of it and what it cost, for the clock readout ("Which clock works"). In
 * the learning loops' record shape: what was seen, what was proposed, what was decided, and the
 * outcome. Each section is written once, by code, when it happens.
 */
export interface RefreshRecord {
  id: string;
  tenantId: string;
  reviewId: string;
  planId: string;
  workspaceId: string;
  /** YYYY-MM it started, against the brand's monthly cap. */
  month: string;
  startedAt: string;
  by: ReviewBy;
  observation: {
    clockDays: number | null;
    arm: "test" | "fixed" | null;
    state: "fresh" | "soon" | "due" | null;
    reasons: string[];
    dueAt: string | null;
    waitedDays: number | null;
    liveUrl: string | null;
  };
  proposal: { count: number; kinds: Partial<Record<ProposalKind, number>>; at: string } | null;
  decision: { outcome: "applied" | "nothing" | "dismissed" | "stopped" | "failed"; accepted: number; real: boolean; at: string; byUid: string | null } | null;
  cost: { searches: number; tokens: number; cents: number } | null;
  /** Search Console 28 days before and after the decision, beside the brand's articles left alone. */
  outcome: {
    searchConsole: boolean;
    before: PageWindow | null;
    after: PageWindow | null;
    /** The brand's other live articles, not refreshed in those 56 days: clicks before and after. */
    control: { before: number; after: number; pages: number } | null;
    /** Clicks after against before, beside the control's change: 0.12 = 12% better. Null: can't say. */
    lift: number | null;
    measuredAt: string;
  } | null;
}
