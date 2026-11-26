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
  CompetitorSection,
  CompetitorStatus,
} from "@/lib/types/competitor";
import type { CompetitorGroupKind } from "@/lib/types/brandStrategy";
import { isFileHost } from "./hosts";
import { cleanTitle } from "./titles";

/**
 * What the page and Vizzy see of a competitor: no lease, no read queue, no internals. Pure and
 * client-safe (the page imports the types and the words).
 */

export interface CompetitorSummary {
  id: string;
  name: string;
  website: string;
  site: string;
  /** The group a person put it in (STRATEGY_COMPETITORS_ENABLED); missing on one never grouped. */
  group?: CompetitorGroupKind | null;
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
  /** Outside sites it links only to name them (an investor, a partner, a person): not cited. */
  mentionLinks: Array<{ url: string; anchor: string }>;
};

/** An ask we can name. Older reads kept links that asked for nothing we name as "other" asks. */
const namedAsk = (x: { kind: ArticleAskKind }) => x.kind !== "other";

/**
 * One of their articles as the page shows it. `names` (the competitor's name and site) take the
 * site's name off the end of its title.
 */
export function articleViewOf(a: CompetitorArticle, names: string[] = []): ArticleView {
  const asks = a.asks.filter(namedAsk);
  const unnamed = new Set(a.asks.filter((x) => !namedAsk(x)).map((x) => x.url));
  const seen = new Set(asks.map((x) => x.url));
  const mentioned = new Set<string>();
  return {
    id: a.id,
    url: a.url,
    title: cleanTitle(a.title, names),
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
    sources: a.sources.filter((x) => !isFileHost(x.url)),
    asks,
    mentions: a.mentions,
    author: a.trust.author,
    updatedAt: a.trust.updatedAt,
    pushes: a.links
      // Each page once, and not again when it is already one of the asks.
      // A link to one of their own products the reader called a mention is still a page they push.
      .filter((l) => l.internal && (l.role === "in_text" || l.role === "mention" || unnamed.has(l.url)) && (seen.has(l.url) ? false : (seen.add(l.url), true)))
      .slice(0, 12)
      .map((l) => ({ url: l.url, anchor: l.anchor })),
    mentionLinks: a.links
      .filter((l) => !l.internal && l.role === "mention" && (mentioned.has(l.url) ? false : (mentioned.add(l.url), true)))
      .slice(0, 8)
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
    // Only once someone has grouped it: a record made while it is off reads as before.
    ...(c.group !== undefined ? { group: c.group } : {}),
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
  const names = [c.name, c.site];
  return {
    ...summaryOf(c, changes, onBrandMap),
    analysis: c.analysis,
    sitemapFiles: c.sitemap?.files.slice(0, 25) ?? [],
    sitemapFoundBy: c.sitemap?.foundBy ?? null,
    newsChosenBy: c.news?.chosenBy ?? null,
    nextPostsCheckAt: c.news ? c.nextPostsCheckAt : null,
    nextSiteCheckAt: c.sitemap ? c.nextSiteCheckAt : null,
    changes: changes.map((ch) => ({ ...ch, posts: ch.posts.map((p) => ({ ...p, title: cleanTitle(p.title, names) })) })),
    posts: posts
      .filter((p) => !p.baseline)
      .slice(0, 30)
      .map((p) => ({ url: p.url, title: cleanTitle(p.title, names), publishedAt: p.publishedAt, firstSeenAt: p.firstSeenAt })),
    articles: articles ? articles.list.slice(0, 100).map((a) => articleViewOf(a, names)) : null,
    articleTotals: articles ? articleTotals(articles.list, c.analysis?.sections ?? []) : null,
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
  /** The earliest and latest publishing days of the articles read. */
  span: { from: string | null; to: string | null };
  formats: Tally[];
  stages: Tally[];
  /** Job roles, singular and plural counted as one ("Heads of SEO" and "Head of SEO"). */
  roles: Tally[];
  /** The kinds of company they write for, when the reader named one. */
  companies: Tally[];
  /** Asks we can name, once per article. */
  asks: Tally[];
  /** Their own pages the articles send readers to (in the text and in asks), by path, named. */
  pushed: PushedPage[];
  /** Outside sites they cite: pages that back a claim, never a file host. */
  cited: Tally[];
  stats: { total: number; theirOwn: number };
}

/** One of their pages their articles send readers to. */
export interface PushedPage extends Tally {
  /** The path, e.g. "/contact-sales". */
  key: string;
  /** What their links call it most often, else words from its address. */
  name: string;
  /** Its site section, from how their site is built ("Features"), when known. */
  section: string | null;
}

/** Count values that mean the same thing as one (`keyOf` says which), shown in the form used most. */
function tallyBy(values: string[], top: number, keyOf: (v: string) => string = (v) => v.toLowerCase()): Tally[] {
  const groups = new Map<string, { count: number; forms: Map<string, number> }>();
  for (const v of values) {
    const k = v.trim();
    if (!k) continue;
    const id = keyOf(k);
    const g = groups.get(id) ?? { count: 0, forms: new Map<string, number>() };
    g.count += 1;
    g.forms.set(k, (g.forms.get(k) ?? 0) + 1);
    groups.set(id, g);
  }
  // The form used most; on a tie the plural ("SEO professionals"), which reads better as a reader,
  // then the one with capitals, which keeps a product's own name ("Prompt Volumes").
  const capitals = (s: string) => s.replace(/[^A-Z]/g, "").length;
  const shown = (forms: Map<string, number>) =>
    [...forms].sort(
      (a, b) => b[1] - a[1] || Number(/s$/i.test(b[0])) - Number(/s$/i.test(a[0])) || capitals(b[0]) - capitals(a[0]) || a[0].localeCompare(b[0]),
    )[0]![0];
  return [...groups.values()]
    .map((g) => ({ key: shown(g.forms), count: g.count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, top);
}

const tally = (values: string[], top: number): Tally[] => tallyBy(values, top);

/** "managers" → "manager", "agencies" → "agency"; "sales", "business" and short words stay. */
const singular = (w: string) => (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w) ? (/ies$/.test(w) ? `${w.slice(0, -3)}y` : w.slice(0, -1)) : w);

/** A job role as one key whatever its case or number: "Heads of SEO" and "head of SEO" match. */
export const roleKey = (role: string) => role.toLowerCase().split(/\s+/).filter(Boolean).map(singular).join(" ");

const upperFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
};

/** Link words that name nothing. */
const VAGUE = /^(here|this|click here|learn more|read more|more|link|this page|see more|find out more)$/i;

/** "/features/prompt-volumes" → "Prompt volumes". */
const wordsOfPath = (path: string) => upperFirst((path.split("/").filter(Boolean).at(-1) ?? "").replace(/[-_]+/g, " ").trim()) || path;

/** The section a path sits in: the longest section path it starts with. */
function sectionOf(path: string, sections: CompetitorSection[]): string | null {
  const withSlash = `${path}/`;
  const hit = sections
    .filter((s) => s.label && s.path.length > 1 && withSlash.startsWith(s.path.endsWith("/") ? s.path : `${s.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return hit?.label ?? null;
}

/** Their own pages an article sends readers to: links in the text (a product it names too) and in its asks. */
const pushedLinks = (a: CompetitorArticle) => {
  const asked = new Set(a.asks.map((x) => x.url));
  return a.links.filter((l) => l.internal && (l.role === "in_text" || l.role === "ask" || l.role === "mention" || asked.has(l.url)));
};

export function articleTotals(list: CompetitorArticle[], sections: CompetitorSection[] = []): ArticleTotals {
  const read = list.filter((a) => a.status === "read");
  const days = read.flatMap((a) => (a.publishedAt ? [a.publishedAt.slice(0, 10)] : [])).sort();
  const anchors = new Map<string, string[]>();
  for (const a of read) {
    for (const l of pushedLinks(a)) {
      const words = l.anchor.replace(/\s+/g, " ").trim();
      if (words && words.length <= 60 && !VAGUE.test(words)) anchors.set(pathOf(l.url), [...(anchors.get(pathOf(l.url)) ?? []), words]);
    }
  }
  // One count per article: an article that links a page twice pushes it once.
  const pushed: PushedPage[] = tally(read.flatMap((a) => [...new Set(pushedLinks(a).map((l) => pathOf(l.url)))]), 6).map((t) => ({
    ...t,
    name: upperFirst(tally(anchors.get(t.key) ?? [], 1)[0]?.key ?? wordsOfPath(t.key)),
    section: sectionOf(t.key, sections),
  }));
  return {
    read: read.length,
    waiting: list.filter((a) => a.status === "queued" || a.status === "reading").length,
    failed: list.filter((a) => a.status === "failed").length,
    readThroughGoogle: read.filter((a) => a.readBy === "google").length,
    span: { from: days[0] ?? null, to: days.at(-1) ?? null },
    formats: tally(read.flatMap((a) => (a.format ? [a.format] : [])), 6),
    stages: tally(read.flatMap((a) => (a.stage ? [a.stage] : [])), 4),
    roles: tallyBy(read.flatMap((a) => a.reader.roles), 6, roleKey).map((t) => ({ ...t, key: upperFirst(t.key) })),
    companies: tally(read.flatMap((a) => (a.reader.companies ? [a.reader.companies] : [])), 2),
    asks: tally(read.flatMap((a) => [...new Set(a.asks.filter(namedAsk).map((x) => x.kind))]), 6),
    pushed,
    cited: tally(read.flatMap((a) => [...new Set(a.sources.filter((x) => !isFileHost(x.url)).map((x) => x.domain))]), 6),
    stats: { total: read.reduce((n, a) => n + a.stats.length, 0), theirOwn: read.reduce((n, a) => n + a.stats.filter((x) => x.theirOwn).length, 0) },
  };
}

/** One of each kind of article, and more than one ("1 case study", "2 case studies"). */
export const FORMAT_WORDS: Record<ArticleFormat, [string, string]> = {
  how_to: ["how to", "how tos"],
  list: ["list post", "list posts"],
  comparison: ["comparison", "comparisons"],
  case_study: ["case study", "case studies"],
  research: ["research piece", "research pieces"],
  opinion: ["opinion piece", "opinion pieces"],
  news: ["news post", "news posts"],
  guide: ["guide", "guides"],
  glossary: ["glossary page", "glossary pages"],
  template: ["template", "templates"],
  listing: ["listing page", "listing pages"],
  other: ["article", "articles"],
};

/** What each ask asks for, after "ask for". */
const ASK_WORDS: Record<ArticleAskKind, string> = {
  demo: "a demo",
  trial: "a free trial",
  sign_up: "a sign up",
  contact_sales: "a talk with sales",
  download: "a download",
  newsletter: "a newsletter sign up",
  webinar: "a webinar sign up",
  pricing: "a look at pricing",
  other: "something else",
};

/** "a", "a and b", "a, b and c" (or "a, b or c"). */
export const listWords = (items: string[], joiner: "and" | "or" = "and") =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`;

/** A role inside a sentence: "Marketers" → "marketers", but "SEO leads" stays. */
const inSentence = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/**
 * One line for a What changed card from the articles behind its posts, by code: "2 case studies and
 * 1 how to, for SEO professionals. Both ask for a free trial." Null until one of them is read.
 */
export function changeSummaryOf(posts: Array<{ url: string }>, articles: Map<string, Pick<CompetitorArticle, "status" | "format" | "reader" | "asks">>): string | null {
  const got = posts.flatMap((p) => {
    const a = articles.get(p.url);
    return a?.status === "read" ? [a] : [];
  });
  if (!got.length) return null;
  const formats = tally(got.map((a) => a.format ?? "other"), 3).map((t) => {
    const [one, many] = FORMAT_WORDS[t.key as ArticleFormat] ?? FORMAT_WORDS.other;
    return `${t.count} ${t.count === 1 ? one : many}`;
  });
  const role = tallyBy(got.flatMap((a) => a.reader.roles), 1, roleKey)[0];
  const parts = [`${upperFirst(listWords(formats))}${role ? `, for ${inSentence(role.key)}` : ""}.`];
  const ask = tally(got.flatMap((a) => [...new Set(a.asks.filter(namedAsk).map((x) => x.kind))]), 1)[0];
  if (ask) {
    const words = ASK_WORDS[ask.key as ArticleAskKind];
    const who =
      ask.count < got.length ? `${ask.count} of ${got.length} ask${ask.count === 1 ? "s" : ""}` : got.length === 1 ? "It asks" : got.length === 2 ? "Both ask" : "All ask";
    parts.push(`${who} for ${words}.`);
  }
  const left = posts.length - got.length;
  if (left > 0) parts.push(`${left} more still to read.`);
  return parts.join(" ");
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
  listing: "Listing page",
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
  other: "Other",
};

/** Why an article wasn't read. */
export const ARTICLE_PROBLEM_TEXT: Record<ArticleProblem, string> = {
  blocked: "Their robots.txt asks readers like ours to keep out of this page.",
  turned_away: "Their site turned our reader away.",
  unreachable: "We couldn't reach this page.",
  not_an_article: "This page is too short to be an article.",
  listing: "This page lists other posts. It isn't an article.",
  no_answer: "Our reader didn't finish this article in time.",
  removed: "This page is gone from their site.",
};

/** Read through Google: no text of ours to check stats, links or asks against. */
export const GOOGLE_ARTICLE_NOTE = "Read through Google: what it covers and who it is for, without its stats, links or asks.";

const label = <K extends string>(labels: Record<K, string>, key: string) => labels[key as K] ?? key;
export const formatLabel = (key: string) => label(FORMAT_LABEL, key);
export const stageLabel = (key: string) => label(STAGE_LABEL, key);
export const askLabel = (key: string) => label(ASK_LABEL, key);
