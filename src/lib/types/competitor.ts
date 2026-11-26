import { z } from "zod";
import { CompetitorGroupKind } from "./brandStrategy";

/**
 * Competitors (COMPETITORS_ENABLED): another business's website a brand watches. One document per
 * competitor in `competitors`, its sitemap's pages in `competitor_pages` (chunks, one generation per
 * read), the posts seen on its news page in `competitor_posts`, and what changed in
 * `competitor_changes`. All regional, beside the brand's content.
 *
 * A competitor moves `finding` → `reading` → `analysing` → `watching`, one bounded step at a time
 * (src/lib/competitors/steps.ts). `paused` is a person's choice; `needs_you` means we couldn't go
 * on without them (no sitemap and no news page, or checks failing).
 */

export const COMPETITOR_LIMITS = {
  /** Competitors one brand may watch. */
  MAX_PER_BRAND: 10,
  /** Like a brand map name: one line, at most 80 characters. */
  MAX_NAME: 80,
  /** Sitemap files read for one baseline (an index counts as one). */
  MAX_SITEMAP_FILES: 25,
  /** How deep sitemap indexes are followed (root = 0). */
  MAX_SITEMAP_DEPTH: 2,
  /** Bytes read of one sitemap file, after unzipping. A bigger file counts as truncated. */
  MAX_SITEMAP_BYTES: 10 * 1024 * 1024,
  /** Pages kept per baseline: "the first 10,000 of about N" on a big site. */
  MAX_PAGES: 10_000,
  /** A page's path is cut to this many characters. */
  MAX_PATH: 500,
  /** One chunk document's lines, in bytes (Firestore's limit is 1 MiB a document). */
  CHUNK_BYTES: 700 * 1024,
  /** Posts remembered per competitor (oldest go first). */
  MAX_POSTS: 300,
  /** Changes kept per competitor: about a year of weekly and monthly checks. */
  MAX_CHANGES: 60,
  /** New posts read and summarised in one weekly check. */
  MAX_NEW_POSTS: 10,
  /** Sample paths kept per section of a site change. */
  MAX_SAMPLE_PATHS: 50,
  /** Failed checks in a row before a competitor needs a person. */
  FAILURES_BEFORE_NEEDS_YOU: 3,
  /** Older articles read when a competitor's articles are first read (COMPETITOR_ARTICLES_ENABLED). */
  ARTICLE_BACKFILL: 20,
  /** Tries at one article before it counts as failed. */
  ARTICLE_ATTEMPTS: 2,
} as const;

export const COMPETITOR_CADENCE = {
  POSTS_DAYS: 7,
  SITE_DAYS: 30,
  /** A failed check is tried again this much later. */
  RETRY_HOURS: 24,
} as const;

export const COMPETITOR_STATUSES = ["finding", "reading", "analysing", "watching", "paused", "needs_you"] as const;
export const CompetitorStatus = z.enum(COMPETITOR_STATUSES);
export type CompetitorStatus = z.infer<typeof CompetitorStatus>;

/** Why a competitor needs a person, or why its last check failed. Each has words on the page. */
export const COMPETITOR_PROBLEMS = [
  "no_sitemap",
  "site_unreachable",
  "no_news_page",
  "news_unreachable",
  "read_failed",
  "blocked",
  "turned_away",
] as const;
export type CompetitorProblem = (typeof COMPETITOR_PROBLEMS)[number];

/** Where its sitemap came from: robots.txt, a usual address, a web search, or a person. */
export type SitemapFoundBy = "robots" | "common" | "search" | "manual";
/** How its news page was chosen. */
export type NewsChosenBy = "analysis" | "path" | "search" | "manual";
/**
 * How we read the site: ourselves, or through Google (Gemini's URL reader) when the site turns
 * automated readers like ours away. Through Google we watch the news only: links come from their
 * sitemap files, never from a web page, and there is no whole site baseline.
 */
export type CompetitorReader = "direct" | "google";

/** Finding a turned away site's news through Google, one file a step. */
export interface GoogleFind {
  /** Sitemap files still to read through Google, in order. */
  queue: string[];
  /** Their robots.txt has been read (through Google) and its sitemaps queued. */
  robotsRead: boolean;
  /** Their robots.txt, cut short, so every file we queue is one it lets us read. Null: none read. */
  robots: string | null;
  /** Files read so far (a cap, so a site of endless indexes ends). */
  reads: number;
}

/** A new post seen in a check through Google, waiting for its title. */
export interface GooglePendingPost {
  url: string;
  publishedAt: string | null;
}

export interface SitemapFile {
  url: string;
  /** 0 for a root; an index's children are one deeper. */
  depth: number;
}

/** A read of the sitemap in progress, one file per step. Swapped in only when it completes. */
export interface CompetitorRead {
  purpose: "baseline" | "monthly";
  /** Where this read started, and how those files were found (kept as the sitemap's when it completes). */
  roots: string[];
  foundBy: SitemapFoundBy;
  generation: number;
  queue: SitemapFile[];
  /** Files read so far (the next baseline's `files`). */
  done: string[];
  /** Lines written (before duplicates are dropped). */
  lines: number;
  chunks: number;
  /** A file was too big, or the page or file cap was reached. */
  truncated: boolean;
  /** Files that couldn't be read. */
  failed: number;
  startedAt: string;
}

export interface CompetitorSitemap {
  /** Where reading starts: the sitemap files found. */
  roots: string[];
  foundBy: SitemapFoundBy;
  /** The files read for the baseline, so each month compares like with like. */
  files: string[];
  /** Distinct pages in the baseline. */
  pages: number;
  truncated: boolean;
  /** The baseline's chunk generation. */
  generation: number;
  readAt: string;
}

export interface SectionCount {
  /** "/news/" or "/" for pages at the top. */
  path: string;
  pages: number;
}

/** Worked out by code from the baseline: every number on the page comes from here. */
export interface CompetitorStats {
  pages: number;
  sections: SectionCount[];
  /** Language prefixes such as "fr" or "de-at", when the site has them. */
  languages: string[];
  /** Pages with a lastmod in each of the last 12 months, oldest first. */
  datedByMonth: Array<{ month: string; pages: number }>;
  /** Posts a month on the news page, from the sitemap's dates (null when we can't tell). */
  newsPerMonth: number | null;
}

export interface CompetitorSection {
  path: string;
  label: string;
  purpose: string;
  pages: number;
}

export interface CompetitorTheme {
  name: string;
  paths: string[];
}

export interface CompetitorNotable {
  label: string;
  path: string;
  why: string;
}

export interface CompetitorAnalysis {
  /** Two sentences on how the site is built. Empty without AI. */
  summary: string;
  sections: CompetitorSection[];
  themes: CompetitorTheme[];
  notable: CompetitorNotable[];
  worthKnowing: string[];
  stats: CompetitorStats;
  /** Whether Gemini labelled it (false: the numbers only). */
  ai: boolean;
  generatedAt: string;
}

export interface CompetitorNews {
  url: string;
  feedUrl: string | null;
  chosenBy: NewsChosenBy;
  /** Through Google: the sitemap file that lists their posts (read weekly instead of the page). */
  sitemapUrl?: string | null;
  /** When the first read was kept as the baseline (null: not read yet). */
  baselineAt: string | null;
  checkedAt: string | null;
}

export interface Competitor {
  id: string;
  tenantId: string;
  name: string;
  /** Its origin, always https ("https://www.acme.example"). */
  website: string;
  /** Its registrable domain ("acme.example"): only pages on it are read. */
  site: string;
  /** The brand map name it feeds, when we added or found one. "Monitoring" is worked out by name. */
  nameId: string | null;
  status: CompetitorStatus;
  /** The step within a status (finding: "plain" then "search"). */
  stage: string | null;
  problem: CompetitorProblem | null;
  /** Failed checks in a row. */
  failures: number;
  sitemap: CompetitorSitemap | null;
  read: CompetitorRead | null;
  analysis: CompetitorAnalysis | null;
  /** The site changed enough this month to put words to its shape again. */
  relabel: boolean;
  news: CompetitorNews | null;
  /**
   * The group a person put it in, the same groups the brand strategy uses (STRATEGY_COMPETITORS_ENABLED),
   * from Brand › Competitors or the Strategy tab. Missing or null: not grouped yet.
   */
  group?: CompetitorGroupKind | null;
  /** Missing on competitors added before there was a choice: "direct". */
  reader?: CompetitorReader;
  googleFind?: GoogleFind | null;
  googlePending?: GooglePendingPost[] | null;
  /** When the article lane last queued this competitor's posts (only that lane writes it). */
  articlesScannedAt?: string | null;
  /** When the article lane dated posts stored without dates from their news page (once). Only the lane writes it. */
  postsDatedAt?: string | null;
  nextPostsCheckAt: string | null;
  nextSiteCheckAt: string | null;
  lastPostsCheckAt: string | null;
  lastSiteCheckAt: string | null;
  leaseUntil: string | null;
  leaseId: string | null;
  addedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One chunk of a baseline: lines of "path\tYYYY-MM-DD" (the date may be empty). */
export interface CompetitorPagesChunk {
  id: string;
  tenantId: string;
  competitorId: string;
  generation: number;
  n: number;
  lines: string;
}

/** A post seen on a competitor's news page. The first read's posts are the baseline. */
export interface CompetitorPost {
  id: string;
  tenantId: string;
  competitorId: string;
  url: string;
  title: string;
  description: string;
  publishedAt: string | null;
  firstSeenAt: string;
  baseline: boolean;
  /** Where it sat on their news page when we first saw it (0 = top): the order to go by when it has no date. */
  rank?: number | null;
}

export interface ChangedSection {
  section: string;
  count: number;
  sample: string[];
}

export const COMPETITOR_CHANGE_KINDS = ["posts", "site"] as const;
export type CompetitorChangeKind = (typeof COMPETITOR_CHANGE_KINDS)[number];

/** What changed: new posts this week, or pages added and removed this month. */
export interface CompetitorChange {
  id: string;
  tenantId: string;
  competitorId: string;
  kind: CompetitorChangeKind;
  at: string;
  headline: string;
  summary: string;
  topics: string[];
  posts: Array<{ url: string; title: string; publishedAt: string | null }>;
  added: { count: number; sections: ChangedSection[] };
  removed: { count: number; sections: ChangedSection[] };
  /** Stored as null until someone marks it seen, so "unseen" is an equality query. */
  seenAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Their articles (COMPETITOR_ARTICLES_ENABLED): one record per post we read in full, in
// `competitor_articles`, with the same id as its post. Findings and short quotes only, never the
// article's text. Links and addresses always come from our own reading of the page.
// ---------------------------------------------------------------------------------------------

export const ARTICLE_STATUSES = ["queued", "reading", "read", "failed", "skipped"] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/** Why an article wasn't read (shown on the page). */
export const ARTICLE_PROBLEMS = ["blocked", "turned_away", "unreachable", "not_an_article", "listing", "no_answer", "removed"] as const;
export type ArticleProblem = (typeof ARTICLE_PROBLEMS)[number];

/** `listing` is a page that lists other posts (a category or tag page): it is never kept as an article. */
export const ARTICLE_FORMATS = ["how_to", "list", "comparison", "case_study", "research", "opinion", "news", "guide", "glossary", "template", "listing", "other"] as const;
export type ArticleFormat = (typeof ARTICLE_FORMATS)[number];

export const ARTICLE_STAGES = ["awareness", "consideration", "decision", "retention"] as const;
export type ArticleStage = (typeof ARTICLE_STAGES)[number];

/** `source` backs a claim; `mention` only names a company, partner, investor, customer, person or product. */
export const ARTICLE_LINK_ROLES = ["in_text", "ask", "related", "author", "source", "mention", "other"] as const;
export type ArticleLinkRole = (typeof ARTICLE_LINK_ROLES)[number];

export const ARTICLE_ASK_KINDS = ["demo", "trial", "sign_up", "contact_sales", "download", "newsletter", "webinar", "pricing", "other"] as const;
export type ArticleAskKind = (typeof ARTICLE_ASK_KINDS)[number];

export const ARTICLE_ASK_PLACES = ["top", "inline", "end"] as const;
export type ArticleAskPlace = (typeof ARTICLE_ASK_PLACES)[number];

/** Who wrote it and when, from the page's own markup. */
export interface ArticleTrust {
  author: string | null;
  authorUrl: string | null;
  /** ISO day. */
  publishedAt: string | null;
  updatedAt: string | null;
  /** schema.org types the page declares, e.g. BlogPosting, Person, FAQPage. */
  schemaTypes: string[];
}

/** A number the article uses as evidence. `quote` was found, word for word, in the article. */
export interface ArticleStat {
  figure: string;
  about: string;
  quote: string;
  /** From the competitor's own data or customers. Never used as a fact in our drafts. */
  theirOwn: boolean;
  /** The outside page that backs it, when the article links one. */
  source: { url: string; domain: string } | null;
}

export interface ArticleLinkRead {
  url: string;
  anchor: string;
  role: ArticleLinkRole;
  internal: boolean;
}

export interface ArticleCta {
  kind: ArticleAskKind;
  placement: ArticleAskPlace;
  url: string;
  text: string;
}

export interface CompetitorArticle {
  /** The same as its post's id. */
  id: string;
  tenantId: string;
  competitorId: string;
  /** Copied from the post, so trimming old posts never leaves an article without them. */
  url: string;
  title: string;
  publishedAt: string | null;
  status: ArticleStatus;
  problem: ArticleProblem | null;
  attempts: number;
  /** While a lane reads it: no other run takes it until this passes. */
  leaseUntil: string | null;
  leaseId: string | null;
  queuedAt: string;
  readAt: string | null;
  /** "2026-11": counts reads against the brand's monthly cap (an equality query). */
  readMonth: string | null;
  /** Read from the page itself, or through Google for a site that turns us away (no stats, links or asks then). */
  readBy: CompetitorReader | null;
  /** The version of the reader that wrote these findings. */
  version: number;
  summary: string;
  question: string;
  angle: string;
  /** The article's subject in a few words, when nothing on the brand map fits. */
  newTopic: string | null;
  format: ArticleFormat | null;
  stage: ArticleStage | null;
  /** Ids on the brand's own map. */
  subjectIds: string[];
  situationIds: string[];
  audienceIds: string[];
  reader: { roles: string[]; companies: string; pains: string[] };
  words: number;
  headings: string[];
  stats: ArticleStat[];
  sources: Array<{ url: string; domain: string; anchor: string }>;
  links: ArticleLinkRead[];
  asks: ArticleCta[];
  trust: ArticleTrust;
  /** Your names found in the text, other competitors it names, and their own products it pushes. */
  mentions: { you: string[]; others: string[]; products: string[] };
}

const Name = z
  .string()
  .trim()
  .min(1)
  .max(COMPETITOR_LIMITS.MAX_NAME)
  .refine((s) => !/[\r\n]/.test(s), "one line");

/** What a person gives to start watching a competitor. */
export const MonitorInputSchema = z.object({
  website: z.string().trim().min(3).max(2048),
  name: Name,
  /** The finder's group, when it is Monitor on one it found (STRATEGY_COMPETITORS_ENABLED; left out while off). */
  group: CompetitorGroupKind.nullable().optional(),
});
export type MonitorInput = z.infer<typeof MonitorInputSchema>;

/** What a person can change on a competitor. */
export const CompetitorPatchSchema = z
  .object({
    name: Name.optional(),
    /** Their news page, typed by a person. */
    newsUrl: z.string().trim().min(3).max(2048).optional(),
    /** Their sitemap, typed by a person (when we couldn't find one). */
    sitemapUrl: z.string().trim().min(3).max(2048).optional(),
    paused: z.boolean().optional(),
    /** The group a person chose, or null for not grouped (STRATEGY_COMPETITORS_ENABLED; left out while off). */
    group: CompetitorGroupKind.nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "nothing to change");
export type CompetitorPatch = z.infer<typeof CompetitorPatchSchema>;
