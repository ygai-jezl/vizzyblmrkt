import type {
  ArticleAskKind,
  ArticleFormat,
  ArticleProblem,
  ArticleStage,
  Competitor,
  CompetitorAnalysis,
  CompetitorArticle,
  CompetitorChange,
  CompetitorPost,
  CompetitorProblem,
  CompetitorStatus,
} from "@/lib/types/competitor";

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
  /** Their site turns automated readers away, so we read their news through Google (news only). */
  readThroughGoogle: boolean;
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
  /** Their articles read in full; null when this brand doesn't have them (COMPETITOR_ARTICLES_ENABLED). */
  articles: ArticleView[] | null;
  articleTotals: ArticleTotals | null;
  /** Brand map subject id → its name, for the subjects their articles are on. */
  subjectNames: Record<string, string>;
}

/** One of their articles as the page shows it: no lease, no queue fields. */
export type ArticleView = Pick<
  CompetitorArticle,
  | "id"
  | "url"
  | "title"
  | "publishedAt"
  | "status"
  | "problem"
  | "readBy"
  | "summary"
  | "question"
  | "angle"
  | "newTopic"
  | "format"
  | "stage"
  | "subjectIds"
  | "reader"
  | "words"
  | "stats"
  | "sources"
  | "asks"
  | "mentions"
> & {
  author: string | null;
  updatedAt: string | null;
  /** Their own pages it sends readers to, in the text. */
  pushes: Array<{ url: string; anchor: string }>;
};

export function articleViewOf(a: CompetitorArticle): ArticleView {
  const seen = new Set(a.asks.map((x) => x.url));
  return {
    id: a.id,
    url: a.url,
    title: a.title,
    publishedAt: a.publishedAt,
    status: a.status,
    problem: a.problem,
    readBy: a.readBy,
    summary: a.summary,
    question: a.question,
    angle: a.angle,
    newTopic: a.newTopic,
    format: a.format,
    stage: a.stage,
    subjectIds: a.subjectIds,
    reader: a.reader,
    words: a.words,
    stats: a.stats,
    sources: a.sources,
    asks: a.asks,
    mentions: a.mentions,
    author: a.trust.author,
    updatedAt: a.trust.updatedAt,
    pushes: a.links
      // Each page once, and not again when it is already one of the asks.
      .filter((l) => l.internal && l.role === "in_text" && (seen.has(l.url) ? false : (seen.add(l.url), true)))
      .slice(0, 12)
      .map((l) => ({ url: l.url, anchor: l.anchor })),
  };
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
    readThroughGoogle: c.reader === "google",
    latest: unseen[0] ? { headline: unseen[0].headline, at: unseen[0].at } : null,
    unseen: unseen.length,
    nextCheckAt: c.status === "watching" ? earliest(c.news ? c.nextPostsCheckAt : null, c.sitemap ? c.nextSiteCheckAt : null) : null,
    lastCheckAt: latest(c.lastPostsCheckAt, c.lastSiteCheckAt),
    onBrandMap,
    createdAt: c.createdAt,
  };
}

export function detailOf(
  c: Competitor,
  changes: CompetitorChange[],
  posts: CompetitorPost[],
  onBrandMap: boolean,
  articles: { list: CompetitorArticle[]; subjectNames: Record<string, string> } | null = null,
): CompetitorDetail {
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
    articles: articles ? articles.list.slice(0, 100).map(articleViewOf) : null,
    articleTotals: articles ? articleTotals(articles.list) : null,
    subjectNames: articles?.subjectNames ?? {},
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
  turned_away: "Their site turns away automated readers like ours, so we couldn't read it. Try again later, or watch a different competitor.",
};

/** A competitor we read through Google, because its site turns automated readers away. */
export const GOOGLE_NOTE =
  "Their site turns away automated readers like ours, so we read their news through Google. We can't see their whole site, so there are no monthly site checks.";

// ---------------------------------------------------------------------------------------------
// Their articles: totals (worked out when a page asks) and the words for them
// ---------------------------------------------------------------------------------------------

export interface Tally {
  key: string;
  count: number;
}

export interface ArticleTotals {
  read: number;
  waiting: number;
  failed: number;
  readThroughGoogle: number;
  formats: Tally[];
  stages: Tally[];
  roles: Tally[];
  asks: Tally[];
  /** Their own pages the articles send readers to (in the text and in asks), by path. */
  pushed: Tally[];
  /** Outside sites they cite. */
  cited: Tally[];
  stats: { total: number; theirOwn: number };
}

function tally(values: string[], top: number): Tally[] {
  const counts = new Map<string, { key: string; count: number }>();
  for (const v of values) {
    const k = v.trim();
    if (!k) continue;
    const id = k.toLowerCase();
    const row = counts.get(id) ?? { key: k, count: 0 };
    row.count += 1;
    counts.set(id, row);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, top);
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
};

export function articleTotals(list: CompetitorArticle[]): ArticleTotals {
  const read = list.filter((a) => a.status === "read");
  return {
    read: read.length,
    waiting: list.filter((a) => a.status === "queued" || a.status === "reading").length,
    failed: list.filter((a) => a.status === "failed").length,
    readThroughGoogle: read.filter((a) => a.readBy === "google").length,
    formats: tally(read.flatMap((a) => (a.format ? [a.format] : [])), 6),
    stages: tally(read.flatMap((a) => (a.stage ? [a.stage] : [])), 4),
    roles: tally(read.flatMap((a) => a.reader.roles), 6),
    asks: tally(read.flatMap((a) => [...new Set(a.asks.map((x) => x.kind))]), 6),
    // One count per article: an article that links a page twice pushes it once.
    pushed: tally(read.flatMap((a) => [...new Set(a.links.filter((l) => l.internal && (l.role === "in_text" || l.role === "ask")).map((l) => pathOf(l.url)))]), 6),
    cited: tally(read.flatMap((a) => [...new Set(a.sources.map((s) => s.domain))]), 6),
    stats: { total: read.reduce((n, a) => n + a.stats.length, 0), theirOwn: read.reduce((n, a) => n + a.stats.filter((s) => s.theirOwn).length, 0) },
  };
}

export const FORMAT_LABEL: Record<ArticleFormat, string> = {
  how_to: "How to",
  list: "List",
  comparison: "Comparison",
  case_study: "Case study",
  research: "Research",
  opinion: "Opinion",
  news: "News",
  guide: "Guide",
  glossary: "Glossary",
  template: "Template",
  other: "Other",
};

/** The reader's stage, in words any business uses. */
export const STAGE_LABEL: Record<ArticleStage, string> = {
  awareness: "Just learning",
  consideration: "Weighing options",
  decision: "Ready to buy",
  retention: "Already a customer",
};

export const ASK_LABEL: Record<ArticleAskKind, string> = {
  demo: "Book a demo",
  trial: "Free trial",
  sign_up: "Sign up",
  contact_sales: "Talk to sales",
  download: "Download",
  newsletter: "Newsletter",
  webinar: "Webinar",
  pricing: "Pricing",
  other: "Other ask",
};

/** Why an article wasn't read. */
export const ARTICLE_PROBLEM_TEXT: Record<ArticleProblem, string> = {
  blocked: "Their robots.txt asks readers like ours to keep out of this page.",
  turned_away: "Their site turned our reader away.",
  unreachable: "We couldn't reach this page.",
  not_an_article: "This page is too short to be an article.",
  no_answer: "Our reader didn't finish this article in time.",
  removed: "This page is gone from their site.",
};

/** Read through Google: no text of ours to check stats, links or asks against. */
export const GOOGLE_ARTICLE_NOTE = "Read through Google: what it covers and who it is for, without its stats, links or asks.";

const label = <K extends string>(labels: Record<K, string>, key: string) => labels[key as K] ?? key;
export const formatLabel = (key: string) => label(FORMAT_LABEL, key);
export const stageLabel = (key: string) => label(STAGE_LABEL, key);
export const askLabel = (key: string) => label(ASK_LABEL, key);
