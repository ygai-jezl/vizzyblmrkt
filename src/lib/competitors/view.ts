import type { Competitor, CompetitorAnalysis, CompetitorChange, CompetitorPost, CompetitorProblem, CompetitorStatus } from "@/lib/types/competitor";

/**
 * What the page and Vizzy see of a competitor: no lease, no read queue, no internals. Pure and
 * client-safe (the page imports the types and the words).
 */

export interface CompetitorSummary {
  id: string;
  name: string;
  website: string;
  site: string;
  status: CompetitorStatus;
  problem: CompetitorProblem | null;
  /** While its sitemap is being read: files read and files known. */
  progress: { done: number; total: number } | null;
  pages: number | null;
  truncated: boolean;
  sections: number | null;
  newsPerMonth: number | null;
  newsUrl: string | null;
  feed: boolean;
  /** The newest change nobody has marked seen, and how many there are. */
  latest: { headline: string; at: string } | null;
  unseen: number;
  nextCheckAt: string | null;
  lastCheckAt: string | null;
  onBrandMap: boolean;
  createdAt: string;
}

export interface CompetitorDetail extends CompetitorSummary {
  analysis: CompetitorAnalysis | null;
  sitemapFiles: string[];
  sitemapFoundBy: string | null;
  newsChosenBy: string | null;
  nextPostsCheckAt: string | null;
  nextSiteCheckAt: string | null;
  changes: CompetitorChange[];
  posts: Array<Pick<CompetitorPost, "url" | "title" | "publishedAt" | "firstSeenAt">>;
}

const earliest = (...d: Array<string | null>) => d.filter((x): x is string => Boolean(x)).sort()[0] ?? null;
const latest = (...d: Array<string | null>) => d.filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;

export function summaryOf(c: Competitor, changes: CompetitorChange[], onBrandMap: boolean): CompetitorSummary {
  const unseen = changes.filter((ch) => ch.competitorId === c.id && ch.seenAt === null).sort((a, b) => b.at.localeCompare(a.at));
  const reading = c.read && c.read.generation ? { done: c.read.done.length, total: c.read.done.length + c.read.queue.length } : null;
  return {
    id: c.id,
    name: c.name,
    website: c.website,
    site: c.site,
    status: c.status,
    problem: c.problem,
    progress: reading,
    pages: c.sitemap?.pages ?? null,
    truncated: c.sitemap?.truncated ?? false,
    sections: c.analysis ? c.analysis.stats.sections.filter((s) => !s.path.slice(1, -1).includes("/") || s.path.startsWith("//")).length : null,
    newsPerMonth: c.analysis?.stats.newsPerMonth ?? null,
    newsUrl: c.news?.url ?? null,
    feed: Boolean(c.news?.feedUrl),
    latest: unseen[0] ? { headline: unseen[0].headline, at: unseen[0].at } : null,
    unseen: unseen.length,
    nextCheckAt: c.status === "watching" ? earliest(c.news ? c.nextPostsCheckAt : null, c.sitemap ? c.nextSiteCheckAt : null) : null,
    lastCheckAt: latest(c.lastPostsCheckAt, c.lastSiteCheckAt),
    onBrandMap,
    createdAt: c.createdAt,
  };
}

export function detailOf(c: Competitor, changes: CompetitorChange[], posts: CompetitorPost[], onBrandMap: boolean): CompetitorDetail {
  return {
    ...summaryOf(c, changes, onBrandMap),
    analysis: c.analysis,
    sitemapFiles: c.sitemap?.files.slice(0, 25) ?? [],
    sitemapFoundBy: c.sitemap?.foundBy ?? null,
    newsChosenBy: c.news?.chosenBy ?? null,
    nextPostsCheckAt: c.news ? c.nextPostsCheckAt : null,
    nextSiteCheckAt: c.sitemap ? c.nextSiteCheckAt : null,
    changes,
    posts: posts.filter((p) => !p.baseline).slice(0, 30).map((p) => ({ url: p.url, title: p.title, publishedAt: p.publishedAt, firstSeenAt: p.firstSeenAt })),
  };
}

/** What a status means, in the words on the page. */
export const STATUS_LABEL: Record<CompetitorStatus, string> = {
  finding: "Finding their sitemap",
  reading: "Reading their site",
  analysing: "Learning how their site is built",
  watching: "Watching",
  paused: "Paused",
  needs_you: "Needs you",
};

/** What went wrong, and what to do about it. */
export const PROBLEM_TEXT: Record<CompetitorProblem, string> = {
  no_sitemap: "We couldn't find a sitemap for this site. Paste their sitemap or their news page below.",
  site_unreachable: "We couldn't reach this site. Check the address, then press Try again.",
  no_news_page: "We couldn't find a news or blog page on their site. If they have one, paste it below.",
  news_unreachable: "We couldn't read their news page. We'll try again tomorrow, or paste a different page below.",
  read_failed: "We couldn't read their sitemap this month. We'll try again tomorrow.",
  blocked: "Their robots.txt asks robots not to read their news page, so we don't check it.",
};
