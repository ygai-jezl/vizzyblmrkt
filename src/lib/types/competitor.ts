import { z } from "zod";

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
] as const;
export type CompetitorProblem = (typeof COMPETITOR_PROBLEMS)[number];

/** Where its sitemap came from: robots.txt, a usual address, a web search, or a person. */
export type SitemapFoundBy = "robots" | "common" | "search" | "manual";
/** How its news page was chosen. */
export type NewsChosenBy = "analysis" | "path" | "search" | "manual";

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
  })
  .refine((p) => Object.keys(p).length > 0, "nothing to change");
export type CompetitorPatch = z.infer<typeof CompetitorPatchSchema>;
