import { randomUUID } from "node:crypto";
import { usageMeter } from "@/lib/plans/meter";
import { isGeminiConfigured, type SearchMeter } from "@/lib/agents/gemini";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { allowedFor, robotsSitemaps } from "@/lib/content/blog/crawlers";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { readPostMeta } from "@/lib/content/blog/research";
import {
  COMPETITOR_CADENCE as CADENCE,
  COMPETITOR_LIMITS as LIMITS,
  type Competitor,
  type CompetitorNews,
  type CompetitorPost,
  type CompetitorProblem,
  type CompetitorRead,
  type GoogleFind,
  type SitemapFile,
  type SitemapFoundBy,
} from "@/lib/types/competitor";
import { labelSite, plainAnalysis, searchForSite, summarisePosts, summariseSiteChange, type AnalyseDeps } from "./analyse";
import { diffBaselines, worthReanalysing } from "./diff";
import { feedLinkFromHtml, isPostOf, listingCards, parseFeed, type FeedItem } from "./feed";
import { fetchFeed, fetchHtml, fetchSitemapFile, mayFetch, robotsFor, ROBOTS_TOKEN, type FetchDeps } from "./fetch";
import { isCompetitorsGoogleReaderEnabled } from "./flags";
import {
  GOOGLE_POSTS_MAX,
  GOOGLE_SITEMAP_MAX,
  googleReadPosts,
  googleReadRobots,
  googleReadSitemap,
  titleFromSlug,
  type GoogleDeps,
} from "./google";
import { newsCandidates, sectionOf, sectionTree, statsOf } from "./shape";
import { asHttps, COMMON_SITEMAP_PATHS, keyUrl, onSite, pageKey, parseSitemap, type BaselinePage } from "./sitemap";
import {
  addChange,
  dropGeneration,
  dropOtherGenerations,
  listPosts,
  readGeneration,
  savePosts,
  writeChunks,
  type StoreDeps,
} from "./store";

/**
 * A competitor's life, one bounded step at a time (COMPETITORS_ENABLED):
 *
 *   finding (plain: robots.txt and the usual addresses; search: Gemini with Google Search)
 *   → reading (one sitemap file a step, into a new generation of chunks)
 *   → analysing (labels: the site's shape; news: the news page's first read, its baseline)
 *   → watching (posts weekly, the sitemap monthly, words again when the site changed enough)
 *
 * A site whose bot screen turns us away is read through Google instead (reader "google",
 * COMPETITORS_GOOGLE_READER_ENABLED): finding (search, then google: their robots.txt and sitemap
 * files one a step) → watching its news only, from the sitemap file that lists its posts. Without
 * the switch it needs a person, with words that say why.
 *
 * advanceCompetitor takes a lease on the document, runs steps until its deadline and saves after
 * each, so a closed tab, a timeout or a crash loses one step at most. Three callers share it:
 * Monitor, the page while setup runs, and the scheduled tick (src/lib/competitors/tick.ts).
 */

export interface StepDeps extends StoreDeps, FetchDeps, AnalyseDeps, GoogleDeps {
  /** Milliseconds now (deadlines). */
  clock?: () => number;
  /** The web search meter (tests); otherwise the brand's own. */
  searchMeter?: SearchMeter;
}

/** Time a step needs before it starts: fetching one file, or asking the model. */
const FETCH_MS = 11_000;
const MODEL_MS = 15_000;
/** Kept back from a model call's deadline, for saving after it. */
const MARGIN_MS = 3_000;
/** A lease outlives the deadline by this much, in case saving runs late. */
const LEASE_GRACE_MS = 60_000;

const clockOf = (deps: StepDeps) => deps.clock ?? Date.now;
const isoOf = (ms: number) => new Date(ms).toISOString();
const days = (n: number) => n * 86_400_000;

type Step = "find_plain" | "find_search" | "find_google" | "read" | "labels" | "news" | "posts" | "google_titles" | "site_start" | "relabel" | "restart";

/** Through Google: files queued while finding, files read at most, posts that make a news source. */
const GOOGLE_QUEUE_MAX = 8;
const GOOGLE_READS_MAX = 10;
const GOOGLE_MIN_POSTS = 3;
/** Newest posts read each week through Google. */
const GOOGLE_CHECK_POSTS = 30;
/**
 * A sitemap file that may list posts: its address says so ("/blog/sitemap_index.xml",
 * "post-sitemap.xml") and its own name isn't one of a blog's other lists (categories, tags).
 */
const POSTY = /post|blog|news|article|insight|stor(y|ies)|press|journal|update/i;
const NOT_POSTS = /categor|tag|author|page|video|image|attachment/i;
const postsFile = (url: string) => {
  const path = pathOf(url);
  return POSTY.test(path) && !NOT_POSTS.test(path.split("/").filter(Boolean).at(-1) ?? "");
};

/** Google can read for us: the switch is on and Gemini is set up (or a test gave a reader). */
function googleReady(deps: StepDeps): boolean {
  return isCompetitorsGoogleReaderEnabled() && (deps.readWithGoogle !== undefined || isGeminiConfigured());
}

/** What a competitor needs next, if anything is due. */
export function nextStep(c: Competitor, nowMs: number): Step | null {
  switch (c.status) {
    case "paused":
    case "needs_you":
      return null;
    case "finding":
      return c.stage === "search" ? "find_search" : c.stage === "google" ? "find_google" : "find_plain";
    case "reading":
      return c.read ? "read" : null;
    case "analysing":
      return c.stage === "news" ? "news" : "labels";
    case "watching": {
      if (c.read) return "read";
      if (c.googlePending?.length) return "google_titles";
      // Nothing to watch (left so by an older version): start again.
      if (!c.sitemap && !c.news) return "restart";
      if (c.relabel && c.sitemap) return "relabel";
      if (c.sitemap && c.nextSiteCheckAt && Date.parse(c.nextSiteCheckAt) <= nowMs) return "site_start";
      if (c.news && c.nextPostsCheckAt && Date.parse(c.nextPostsCheckAt) <= nowMs) return "posts";
      return null;
    }
  }
}

/** Time a step needs before it is started. */
function needs(step: Step): number {
  if (step === "restart") return 0;
  return step === "find_search" || step === "find_google" || step === "labels" || step === "relabel" || step === "posts" || step === "google_titles" ? MODEL_MS : FETCH_MS;
}

/**
 * Advance one competitor until `deadlineMs`. Returns it as it now stands, or null when it doesn't
 * exist. When another caller holds the lease, returns it untouched.
 */
export async function advanceCompetitor(ctx: TenantContext, id: string, deadlineMs: number, deps: StepDeps = {}): Promise<Competitor | null> {
  const clock = clockOf(deps);
  const repo = forTenant(ctx, deps.db).competitors;
  const leaseId = randomUUID();
  const claimed = await repo.claim(id, (cur) => {
    if (cur.leaseUntil && Date.parse(cur.leaseUntil) > clock()) return null;
    return { leaseUntil: isoOf(deadlineMs + LEASE_GRACE_MS), leaseId };
  });
  if (!claimed) return repo.getById(id);
  let c = claimed;
  try {
    for (let guard = 0; guard < 40; guard += 1) {
      const step = nextStep(c, clock());
      if (!step || deadlineMs - clock() < needs(step)) break;
      const patch = await runStep(step, c, ctx, deadlineMs, deps);
      if (!patch) break;
      const stamped = { ...patch, updatedAt: isoOf(clock()) };
      await repo.update(id, stamped);
      c = { ...c, ...stamped };
    }
  } catch (err) {
    console.warn(`[competitors] ${ctx.tenantId}/${id} step failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
  } finally {
    await repo
      .claim(id, (cur) => (cur.leaseId === leaseId ? { leaseUntil: null, leaseId: null } : null))
      .catch(() => undefined);
  }
  return { ...c, leaseUntil: null, leaseId: null };
}

async function runStep(step: Step, c: Competitor, ctx: TenantContext, deadlineMs: number, deps: StepDeps): Promise<Partial<Competitor> | null> {
  switch (step) {
    case "find_plain":
      return findPlain(c, deps);
    case "find_search":
      return findSearch(c, ctx, deadlineMs, deps);
    case "find_google":
      return findGoogle(c, ctx, deadlineMs, deps);
    case "read":
      return readOne(c, ctx, deadlineMs, deps);
    case "labels":
    case "relabel":
      return label(c, ctx, deadlineMs, deps, step === "relabel");
    case "news":
      return newsBaseline(c, ctx, deps);
    case "posts":
      return c.reader === "google" ? checkPostsGoogle(c, ctx, deadlineMs, deps) : checkPosts(c, ctx, deadlineMs, deps);
    case "google_titles":
      return googleTitles(c, ctx, deadlineMs, deps);
    case "site_start":
      return startRead(c, "monthly", c.sitemap?.roots ?? [], c.sitemap?.foundBy ?? "common", ctx, deps);
    case "restart":
      return { status: "finding", stage: "plain", problem: null, failures: 0, reader: "direct", googleFind: null, googlePending: null };
  }
}

// ---------------------------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------------------------

type SitemapTry = "sitemap" | "turned_away" | "html" | "none";

/** What a sitemap address gave: a sitemap with at least one entry, their bot screen, a web page, or nothing. */
async function trySitemap(url: string, deps: StepDeps): Promise<SitemapTry> {
  const got = await fetchSitemapFile(url, deps);
  if (!got.ok) return got.reason === "turned_away" ? "turned_away" : "none";
  if (parseSitemap(got.text).entries.length > 0) return "sitemap";
  return /text\/html|application\/xhtml/i.test(got.contentType) || /^\s*<(!doctype|html)\b/i.test(got.text) ? "html" : "none";
}

async function readsAsSitemap(url: string, deps: StepDeps): Promise<boolean> {
  return (await trySitemap(url, deps)) === "sitemap";
}

/** Their bot screen turned us away: read through Google when we can, else say so (a web search can't help). */
function turnedAway(deps: StepDeps): Partial<Competitor> {
  return googleReady(deps) ? { status: "finding", reader: "google", stage: "search", problem: null } : { status: "needs_you", stage: null, problem: "turned_away" };
}

async function startRead(
  c: Competitor,
  purpose: CompetitorRead["purpose"],
  roots: string[],
  foundBy: SitemapFoundBy,
  ctx: TenantContext,
  deps: StepDeps,
): Promise<Partial<Competitor>> {
  const generation = Math.max(c.sitemap?.generation ?? 0, c.read?.generation ?? 0) + 1;
  // Leftovers of a read that never finished.
  await dropGeneration(ctx, c.id, generation, deps);
  const read: CompetitorRead = {
    purpose,
    roots,
    foundBy,
    generation,
    queue: roots.slice(0, LIMITS.MAX_SITEMAP_FILES).map((url) => ({ url, depth: 0 })),
    done: [],
    lines: 0,
    chunks: 0,
    truncated: false,
    failed: 0,
    startedAt: isoOf(clockOf(deps)()),
  };
  return purpose === "baseline" ? { status: "reading", stage: null, read } : { read };
}

async function findPlain(c: Competitor, deps: StepDeps): Promise<Partial<Competitor>> {
  const robots = await robotsFor(c.website, deps);
  // The site answers from another address of its own ("www."): read from there from now on.
  const website = robots.origin !== c.website && onSite(robots.origin, c.site) && robots.origin.startsWith("https://") ? robots.origin : c.website;
  const moved = website !== c.website ? { website } : {};
  const named = robotsSitemaps(robots.text).filter((u) => onSite(u, c.site)).map(asHttps).slice(0, 5);
  const tried: SitemapTry[] = [];
  for (const url of named.slice(0, 2)) {
    const got = await trySitemap(url, deps);
    if (got === "sitemap") return { ...startReadLater(named, "robots"), ...moved };
    tried.push(got);
  }
  const tries = COMMON_SITEMAP_PATHS.map((p) => `${website}${p}`);
  const got = await Promise.all(tries.map((u) => trySitemap(u, deps)));
  const found = tries.find((_, i) => got[i] === "sitemap");
  if (found) return { ...startReadLater([found], "common"), ...moved };
  // Their bot screen answered for the site: a refusal or a challenge page, or a web page both where
  // robots.txt and where /sitemap.xml should be.
  if (robots.turnedAway || [...tried, ...got].includes("turned_away") || (robots.html && got[0] === "html")) return { ...turnedAway(deps), ...moved };
  return { stage: "search", ...moved };
}

/** findPlain hands the read's start to the next step (it needs the store, which startRead has). */
function startReadLater(roots: string[], foundBy: SitemapFoundBy): Partial<Competitor> {
  return {
    status: "reading",
    stage: null,
    read: { purpose: "baseline", roots, foundBy, generation: 0, queue: [], done: [], lines: 0, chunks: 0, truncated: false, failed: 0, startedAt: "" },
  };
}

async function findSearch(c: Competitor, ctx: TenantContext, deadlineMs: number, deps: StepDeps): Promise<Partial<Competitor>> {
  const timeoutMs = deadlineMs - clockOf(deps)() - MARGIN_MS;
  const meter = deps.searchMeter ?? usageMeter(ctx, "web_searches", "competitor_site", { db: deps.db });
  const found = await searchForSite({ name: c.name, website: c.website, site: c.site }, timeoutMs, meter, deps);
  const news: CompetitorNews | null = found?.news ? { url: found.news, feedUrl: null, chosenBy: "search", baselineAt: null, checkedAt: null } : null;
  if (c.reader === "google") {
    // We can't fetch it ourselves: Google reads their robots.txt and these files, one a step.
    const googleFind: GoogleFind = { queue: googleQueue(c, found?.sitemap ?? null, found?.news ?? null), robotsRead: false, robots: null, reads: 0 };
    return { stage: "google", googleFind, ...(news ? { news } : {}) };
  }
  if (found?.sitemap && (await readsAsSitemap(found.sitemap, deps))) {
    return { ...startReadLater([found.sitemap], "search"), ...(news ? { news } : {}) };
  }
  if (news) return { status: "analysing", stage: "news", news };
  return { status: "needs_you", stage: null, problem: "no_sitemap" };
}

// ---------------------------------------------------------------------------------------------
// Through Google: their news, from the sitemap file that lists their posts
// ---------------------------------------------------------------------------------------------

const unique = (urls: string[]) => [...new Set(urls)];

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return "/";
  }
}

/** Where a sitemap of their posts usually is: the one search found, beside their news page, then the usual addresses. */
function googleQueue(c: Competitor, sitemap: string | null, newsUrl: string | null): string[] {
  const news = newsUrl ? newsUrl.replace(/[?#].*$/, "").replace(/\/+$/, "") : null;
  const list = [
    sitemap,
    news && `${news}/sitemap_index.xml`,
    news && `${news}/post-sitemap.xml`,
    news && `${news}/sitemap.xml`,
    `${c.website}/post-sitemap.xml`,
    `${c.website}/sitemap_index.xml`,
    `${c.website}/sitemap.xml`,
  ];
  return unique(list.filter((u): u is string => Boolean(u)).map(asHttps).filter((u) => onSite(u, c.site))).slice(0, GOOGLE_QUEUE_MAX);
}

/** Their news page from the posts a sitemap file lists, when search didn't name one: the biggest news-like section. */
function newsFromEntries(entries: Array<{ loc: string }>, c: Competitor): string | null {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = pageKey(e.loc, c.website, c.site);
    if (key) counts.set(sectionOf(key), (counts.get(sectionOf(key)) ?? 0) + 1);
  }
  const best = newsCandidates([...counts].map(([path, pages]) => ({ path, pages })))[0];
  if (!best) return null;
  return best.path.startsWith("//") ? `https:${best.path.replace(/\/+$/, "")}` : `${c.website}${best.path.replace(/\/+$/, "")}`;
}

/**
 * One file through Google a step: first their robots.txt (its sitemaps go first in the queue, and
 * its rules decide what we may read), then sitemap files until one lists at least a few posts under
 * their news page. That file is what we read every week; the posts it lists now are the baseline.
 */
async function findGoogle(c: Competitor, ctx: TenantContext, deadlineMs: number, deps: StepDeps): Promise<Partial<Competitor>> {
  const stuck: Partial<Competitor> = { status: "needs_you", stage: null, googleFind: null, problem: "turned_away" };
  if (!googleReady(deps)) return stuck;
  const clock = clockOf(deps);
  const timeoutMs = deadlineMs - clock() - MARGIN_MS;
  const gf: GoogleFind = c.googleFind ?? { queue: googleQueue(c, null, c.news?.url ?? null), robotsRead: false, robots: null, reads: 0 };

  if (!gf.robotsRead) {
    const robots = await googleReadRobots(`${c.website}/robots.txt`, timeoutMs, deps);
    const allowed = (url: string) => !robots || allowedFor(robots, ROBOTS_TOKEN, pathOf(url));
    if (c.news && !allowed(c.news.url)) return { ...stuck, problem: "blocked" };
    const named = robots ? robotsSitemaps(robots).map(asHttps).filter((u) => onSite(u, c.site)) : [];
    const queue = unique([...named, ...gf.queue]).filter(allowed).slice(0, GOOGLE_QUEUE_MAX);
    return { googleFind: { queue, robotsRead: true, robots, reads: gf.reads + 1 } };
  }

  const allowed = (url: string) => !gf.robots || allowedFor(gf.robots, ROBOTS_TOKEN, pathOf(url));
  const [url, ...rest] = gf.queue;
  if (!url || gf.reads >= GOOGLE_READS_MAX) return stuck;
  const file = await googleReadSitemap(url, { site: c.site, max: GOOGLE_SITEMAP_MAX }, timeoutMs, deps);
  // No answer in time: the same file again next step (the cap on reads still ends it).
  if (file === "no_answer") return { googleFind: { ...gf, reads: gf.reads + 1 } };
  const next: GoogleFind = { ...gf, queue: rest, reads: gf.reads + 1 };
  if (!file) return { googleFind: next };
  if (file.kind === "index") {
    const children = file.entries
      .map((e) => e.loc)
      .filter((u) => postsFile(u) && !gf.queue.includes(u) && allowed(u))
      .slice(0, 3);
    return { googleFind: { ...next, queue: unique([...children, ...rest]).slice(0, GOOGLE_QUEUE_MAX) } };
  }
  const newsUrl = c.news?.url ?? newsFromEntries(file.entries, c);
  if (!newsUrl || !allowed(newsUrl)) return { googleFind: next };
  const posts = file.entries.filter((e) => isPostOf(e.loc, newsUrl, c.site) && allowed(e.loc));
  if (posts.length < GOOGLE_MIN_POSTS) return { googleFind: next };

  const nowMs = clock();
  // Every post it lists now is the baseline, so next week only new ones are new.
  await keepPosts(ctx, c, posts.map((e) => ({ url: e.loc, title: titleFromSlug(e.loc), publishedAt: e.lastmod })), true, nowMs, deps);
  return {
    status: "watching",
    stage: null,
    problem: null,
    failures: 0,
    googleFind: null,
    news: { url: newsUrl, feedUrl: null, chosenBy: c.news?.chosenBy ?? "path", sitemapUrl: url, baselineAt: isoOf(nowMs), checkedAt: isoOf(nowMs) },
    nextPostsCheckAt: isoOf(nowMs + days(CADENCE.POSTS_DAYS)),
    lastPostsCheckAt: isoOf(nowMs),
    nextSiteCheckAt: null,
    lastSiteCheckAt: null,
  };
}

/** The weekly check through Google: the newest entries of their posts' sitemap file, against the posts we know. */
async function checkPostsGoogle(c: Competitor, ctx: TenantContext, deadlineMs: number, deps: StepDeps): Promise<Partial<Competitor>> {
  const nowMs = clockOf(deps)();
  const news = c.news!;
  if (!googleReady(deps)) return failed(c, "turned_away", "posts", nowMs);
  // A news page a person gave us: find the sitemap file that lists its posts first.
  if (!news.sitemapUrl) return { status: "finding", stage: "google", googleFind: null };
  const file = await googleReadSitemap(news.sitemapUrl, { site: c.site, max: GOOGLE_CHECK_POSTS }, deadlineMs - nowMs - MARGIN_MS, deps);
  if (!file || file === "no_answer" || file.kind !== "urlset") return failed(c, "turned_away", "posts", nowMs);
  const known = new Set((await listPosts(ctx, c.id, deps)).map((p) => normalizeUrl(p.url) || p.url));
  // A post dated well before we last looked isn't new, however it came back (a guard on a copy).
  const since = Date.parse(news.checkedAt ?? news.baselineAt ?? "") - days(14);
  const fresh = file.entries
    .filter((e) => isPostOf(e.loc, news.url, c.site) && !known.has(normalizeUrl(e.loc) || e.loc))
    .filter((e) => !e.lastmod || Number.isNaN(since) || Date.parse(e.lastmod) >= since)
    .slice(0, LIMITS.MAX_NEW_POSTS * 5);
  const updates: Partial<Competitor> = {
    news: { ...news, checkedAt: isoOf(nowMs) },
    nextPostsCheckAt: isoOf(nowMs + days(CADENCE.POSTS_DAYS)),
    lastPostsCheckAt: isoOf(nowMs),
    failures: 0,
    ...(c.problem === "turned_away" ? { problem: null } : {}),
  };
  if (!fresh.length) return updates;
  // Their titles are read next step, so this one stays inside its time.
  return { ...updates, googlePending: fresh.map((e) => ({ url: e.loc, publishedAt: e.lastmod })) };
}

/** New posts found through Google: their titles (from the posts themselves), then what changed. */
async function googleTitles(c: Competitor, ctx: TenantContext, deadlineMs: number, deps: StepDeps): Promise<Partial<Competitor>> {
  const clock = clockOf(deps);
  const nowMs = clock();
  const pending = c.googlePending ?? [];
  const asked = pending.slice(0, GOOGLE_POSTS_MAX).map((p) => p.url);
  // Leave a little time for the summary; without it the headline is written by code.
  const titles = googleReady(deps) ? await googleReadPosts(asked, Math.max(1_000, deadlineMs - nowMs - MARGIN_MS - 3_000), deps) : new Map();
  const read = pending.map((p) => {
    const t = titles.get(p.url);
    return { url: p.url, title: t?.title || titleFromSlug(p.url), publishedAt: p.publishedAt ?? t?.publishedAt ?? null, description: "" };
  });
  await recordNewPosts(ctx, c, read, nowMs, deadlineMs, deps);
  return { googlePending: null };
}

// ---------------------------------------------------------------------------------------------
// Reading the sitemap, one file a step
// ---------------------------------------------------------------------------------------------

async function readOne(c: Competitor, ctx: TenantContext, deadlineMs: number, deps: StepDeps): Promise<Partial<Competitor> | null> {
  let read = c.read!;
  // A read handed over by findPlain/findSearch starts here, where the store is to hand.
  if (!read.generation) {
    const started = await startRead(c, read.purpose, read.roots, read.foundBy, ctx, deps);
    read = started.read!;
  }
  if (!read.queue.length) return finishRead(c, read, ctx, deadlineMs, deps);

  const [file, ...rest] = read.queue as [SitemapFile, ...SitemapFile[]];
  const got = await fetchSitemapFile(file.url, deps);
  const next: CompetitorRead = { ...read, queue: rest, done: [...read.done, file.url] };
  if (!got.ok) {
    next.failed += 1;
    next.done = read.done;
    return { read: next };
  }
  if (got.truncated) next.truncated = true;
  const parsed = parseSitemap(got.text);
  if (parsed.kind === "index") {
    const known = new Set([...next.done, ...next.queue.map((q) => q.url)]);
    for (const e of parsed.entries) {
      const url = asHttps(e.loc);
      if (!onSite(url, c.site) || known.has(url)) continue;
      if (file.depth + 1 > LIMITS.MAX_SITEMAP_DEPTH || next.done.length + next.queue.length >= LIMITS.MAX_SITEMAP_FILES) {
        next.truncated = true;
        break;
      }
      next.queue.push({ url, depth: file.depth + 1 });
      known.add(url);
    }
  } else if (parsed.entries.length) {
    const room = LIMITS.MAX_PAGES - next.lines;
    const pages: BaselinePage[] = [];
    for (const e of parsed.entries) {
      const key = pageKey(e.loc, c.website, c.site);
      if (!key) continue;
      if (pages.length >= room) {
        next.truncated = true;
        break;
      }
      pages.push({ key, lastmod: e.lastmod });
    }
    if (pages.length) {
      next.chunks += await writeChunks(ctx, c.id, next.generation, next.chunks, pages, deps);
      next.lines += pages.length;
    }
  } else if (parsed.kind === "unknown") {
    next.failed += 1;
  }
  if (next.lines >= LIMITS.MAX_PAGES && next.queue.length) {
    next.truncated = true;
    next.queue = [];
  }
  return { read: next };
}

async function finishRead(c: Competitor, read: CompetitorRead, ctx: TenantContext, deadlineMs: number, deps: StepDeps): Promise<Partial<Competitor> | null> {
  const nowMs = clockOf(deps)();
  const pages = await readGeneration(ctx, c.id, read.generation, deps);
  if (read.purpose === "baseline") {
    if (!pages.length) {
      await dropGeneration(ctx, c.id, read.generation, deps);
      // A sitemap with nothing on their site: watch the news page alone if we have one.
      if (c.news) return { status: "analysing", stage: "news", read: null };
      return { status: "needs_you", stage: null, read: null, problem: "no_sitemap" };
    }
    await dropOtherGenerations(ctx, c.id, read.generation, deps);
    return {
      status: "analysing",
      stage: "labels",
      read: null,
      sitemap: { roots: read.roots, foundBy: read.foundBy, files: read.done, pages: pages.length, truncated: read.truncated, generation: read.generation, readAt: isoOf(nowMs) },
    };
  }

  // Monthly: compare with the baseline, cautiously.
  const sitemap = c.sitemap!;
  const before = await readGeneration(ctx, c.id, sitemap.generation, deps);
  if (!pages.length || pages.length < before.length / 2) {
    await dropGeneration(ctx, c.id, read.generation, deps);
    return failed(c, "read_failed", "site", nowMs, { read: null });
  }
  const whole = read.failed === 0 && !read.truncated && !sitemap.truncated;
  const diff = diffBaselines(before, pages, { whole });
  if (!whole) {
    // Keep the old pages this read didn't see: they may simply not have been read.
    const seen = new Set(pages.map((p) => p.key));
    const kept = diff.next.filter((p) => !seen.has(p.key));
    if (kept.length) await writeChunks(ctx, c.id, read.generation, read.chunks, kept, deps);
  }
  await dropOtherGenerations(ctx, c.id, read.generation, deps);
  if (diff.added.count || diff.removed.count) {
    const remaining = deadlineMs - clockOf(deps)() - MARGIN_MS;
    const words = await summariseSiteChange({ name: c.name, website: c.website, before: before.length, after: diff.next.length, diff }, remaining, deps);
    await addChange(
      ctx,
      {
        competitorId: c.id,
        kind: "site",
        at: isoOf(nowMs),
        headline: words.headline,
        summary: words.summary,
        topics: words.topics,
        posts: [],
        added: diff.added,
        removed: diff.removed,
        seenAt: null,
      },
      deps,
    );
  }
  return {
    read: null,
    relabel: worthReanalysing(diff, before.length),
    sitemap: { ...sitemap, files: read.done, pages: diff.next.length, truncated: read.truncated, generation: read.generation, readAt: isoOf(nowMs) },
    lastSiteCheckAt: isoOf(nowMs),
    nextSiteCheckAt: isoOf(nowMs + days(CADENCE.SITE_DAYS)),
    failures: 0,
    ...(c.problem === "read_failed" ? { problem: null } : {}),
  };
}

/** A check that failed: try again tomorrow, and after a few in a row ask a person. */
function failed(c: Competitor, problem: CompetitorProblem, which: "site" | "posts", nowMs: number, extra: Partial<Competitor> = {}): Partial<Competitor> {
  const failures = c.failures + 1;
  const retry = isoOf(nowMs + CADENCE.RETRY_HOURS * 3_600_000);
  const due = which === "site" ? { nextSiteCheckAt: retry } : { nextPostsCheckAt: retry };
  if (failures >= LIMITS.FAILURES_BEFORE_NEEDS_YOU) return { ...extra, ...due, failures, problem, status: "needs_you", stage: null };
  return { ...extra, ...due, failures };
}

// ---------------------------------------------------------------------------------------------
// The site's shape, and choosing the news page
// ---------------------------------------------------------------------------------------------

async function label(c: Competitor, ctx: TenantContext, deadlineMs: number, deps: StepDeps, again: boolean): Promise<Partial<Competitor>> {
  const now = new Date(clockOf(deps)());
  const pages = await readGeneration(ctx, c.id, c.sitemap?.generation ?? 0, deps);
  const sections = sectionTree(pages);
  const candidates = newsCandidates(sections);
  const labels = pages.length
    ? await labelSite({ name: c.name, website: c.website, pages, sections, candidates }, deadlineMs - clockOf(deps)() - MARGIN_MS, deps)
    : null;
  // The news page: a person's choice stands; else the model's pick, the biggest news-like section, or what search found.
  let news = c.news;
  if (!again && news?.chosenBy !== "manual") {
    const section = labels?.newsSection ?? candidates[0]?.path ?? null;
    if (section) {
      // The listing page as their sitemap spells it ("/news", not "/news/"), when it lists it.
      const listed = pages.find((p) => `${p.key}/` === section)?.key ?? section;
      news = { url: keyUrl(listed, c.website), feedUrl: null, chosenBy: labels?.newsSection ? "analysis" : "path", baselineAt: null, checkedAt: null };
    }
  }
  const newsSection = news ? sectionFor(news.url, c, sections.map((s) => s.path)) : null;
  const stats = statsOf(pages, now, newsSection);
  const analysis = labels ? { ...labels.analysis, stats, generatedAt: now.toISOString() } : plainAnalysis(stats, now);
  if (again) return { analysis, relabel: false };
  // A model that failed (rather than one that isn't set up) gets one more go once watching.
  return { analysis, news, status: "analysing", stage: "news", relabel: !labels && pages.length > 0 && isGeminiConfigured() };
}

/** The section a news page sits in, when it is one of the site's sections. */
function sectionFor(url: string, c: Competitor, sections: string[]): string | null {
  const key = pageKey(url, c.website, c.site);
  if (!key) return null;
  const withSlash = key.endsWith("/") ? key : `${key}/`;
  return sections.find((s) => s === withSlash) ?? null;
}

// ---------------------------------------------------------------------------------------------
// The news page: its first read (the baseline) and each week after
// ---------------------------------------------------------------------------------------------

interface Gathered {
  items: FeedItem[];
  feedUrl: string | null;
  /** The page or feed answered at all. */
  reached: boolean;
  /** Their robots.txt asks robots to leave the news page alone. */
  blocked: boolean;
  /** Their bot screen answered instead of the site. */
  turnedAway: boolean;
}

/** The posts the news page lists now: its feed first, else its links, else the sitemap file that lists them. */
async function gatherPosts(c: Competitor, news: CompetitorNews, deps: StepDeps): Promise<Gathered> {
  const origin = new URL(news.url).origin;
  const robots = await robotsFor(origin, deps);
  if (!mayFetch(robots, news.url)) return { items: [], feedUrl: news.feedUrl, reached: false, blocked: robots.reachable, turnedAway: robots.turnedAway };
  let feedUrl = news.feedUrl;
  let reached = false;
  let turnedAway = false;
  let html = "";
  const readPage = async () => {
    const page = await fetchHtml(news.url, deps);
    if (page.ok) {
      reached = true;
      html = page.text;
    } else if (page.reason === "turned_away") {
      turnedAway = true;
    }
    return page;
  };
  if (!feedUrl) {
    const page = await readPage();
    if (page.ok) feedUrl = feedLinkFromHtml(page.text, page.url, c.site);
  }
  if (feedUrl && mayFetch(robots, feedUrl)) {
    const feed = await fetchFeed(feedUrl, deps);
    if (feed.ok) {
      const items = parseFeed(feed.text, feed.url).filter((i) => onSite(i.url, c.site));
      if (items.length) return { items, feedUrl, reached: true, blocked: false, turnedAway: false };
    } else if (feed.reason === "turned_away") {
      turnedAway = true;
    }
  }
  if (!html && !turnedAway) await readPage();
  // Each post with the date on its card, and its place on the page for one that shows none.
  const cards = html ? listingCards(html, news.url, news.url, c.site, new Date(clockOf(deps)())) : [];
  if (cards.length) {
    return { items: cards.map((card) => ({ url: card.url, title: "", publishedAt: card.publishedAt, rank: card.rank })), feedUrl: null, reached, blocked: false, turnedAway: false };
  }

  // A page drawn by script lists nothing we can read: the sitemap file that holds its posts may.
  const file = c.sitemap?.files.find((f) => /post|blog|news|article/i.test(f));
  if (file) {
    const got = await fetchSitemapFile(file, deps);
    if (got.ok) {
      const items = parseSitemap(got.text)
        .entries.filter((e) => isPostOf(asHttps(e.loc), news.url, c.site))
        .sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""))
        .slice(0, 100)
        .map((e) => ({ url: normalizeUrl(asHttps(e.loc)), title: "", publishedAt: e.lastmod }));
      if (items.length) return { items, feedUrl: null, reached: true, blocked: false, turnedAway: false };
    }
  }
  return { items: [], feedUrl, reached, blocked: false, turnedAway };
}

async function newsBaseline(c: Competitor, ctx: TenantContext, deps: StepDeps): Promise<Partial<Competitor>> {
  const nowMs = clockOf(deps)();
  const watching: Partial<Competitor> = {
    status: "watching",
    stage: null,
    nextSiteCheckAt: c.sitemap ? isoOf(nowMs + days(CADENCE.SITE_DAYS)) : null,
    lastSiteCheckAt: c.sitemap ? isoOf(nowMs) : null,
  };
  // With no sitemap and no news to watch there is nothing to do: a person has to help. Never "watching".
  const stuck = (problem: CompetitorProblem, extra: Partial<Competitor> = {}): Partial<Competitor> => ({ ...extra, status: "needs_you", stage: null, problem, nextPostsCheckAt: null });
  if (!c.news) return c.sitemap ? { ...watching, nextPostsCheckAt: null, problem: "no_news_page" } : stuck("no_sitemap");
  const got = await gatherPosts(c, c.news, deps);
  if (got.blocked) return c.sitemap ? { ...watching, problem: "blocked", nextPostsCheckAt: null } : stuck("blocked");
  if (!got.reached && !got.items.length) {
    if (got.turnedAway && !c.sitemap) {
      // Their bot screen answered for the news page too: read it through Google, or say why we can't.
      if (!googleReady(deps)) return stuck("turned_away");
      return { status: "finding", stage: "google", reader: "google", problem: null, googleFind: { queue: googleQueue(c, null, c.news.url), robotsRead: false, robots: null, reads: 0 } };
    }
    // Unreachable now: the weekly check tries again (its first read is still the baseline).
    return { ...watching, problem: got.turnedAway ? "turned_away" : "news_unreachable", nextPostsCheckAt: isoOf(nowMs + CADENCE.RETRY_HOURS * 3_600_000) };
  }
  // A page that lists no posts isn't much of a news page, unless a person chose it.
  if (!got.items.length && c.news.chosenBy !== "manual") return c.sitemap ? { ...watching, problem: "no_news_page", news: null, nextPostsCheckAt: null } : stuck("no_sitemap", { news: null });
  await keepPosts(ctx, c, got.items, true, nowMs, deps);
  return {
    ...watching,
    problem: null,
    news: { ...c.news, feedUrl: got.feedUrl, baselineAt: isoOf(nowMs), checkedAt: isoOf(nowMs) },
    nextPostsCheckAt: isoOf(nowMs + days(CADENCE.POSTS_DAYS)),
    lastPostsCheckAt: isoOf(nowMs),
  };
}

async function keepPosts(ctx: TenantContext, c: Competitor, items: Array<FeedItem & { description?: string }>, baseline: boolean, nowMs: number, deps: StepDeps): Promise<void> {
  const at = isoOf(nowMs);
  const rows: Array<Omit<CompetitorPost, "id" | "tenantId" | "competitorId">> = items.slice(0, LIMITS.MAX_POSTS).map((i) => ({
    url: normalizeUrl(i.url) || i.url,
    title: i.title.slice(0, 200),
    description: (i.description ?? "").slice(0, 400),
    publishedAt: i.publishedAt,
    firstSeenAt: at,
    baseline,
    ...(i.rank !== undefined && i.rank !== null ? { rank: i.rank } : {}),
  }));
  await savePosts(ctx, c.id, rows, deps);
}

async function checkPosts(c: Competitor, ctx: TenantContext, deadlineMs: number, deps: StepDeps): Promise<Partial<Competitor>> {
  const clock = clockOf(deps);
  const nowMs = clock();
  const news = c.news!;
  // Never read yet (it was unreachable at first): this read is the baseline.
  if (!news.baselineAt) return newsBaseline(c, ctx, deps);
  const got = await gatherPosts(c, news, deps);
  if (got.blocked) return { problem: "blocked", nextPostsCheckAt: isoOf(nowMs + days(CADENCE.POSTS_DAYS)) };
  if (!got.reached && !got.items.length) return failed(c, got.turnedAway ? "turned_away" : "news_unreachable", "posts", nowMs);

  const known = new Set((await listPosts(ctx, c.id, deps)).map((p) => normalizeUrl(p.url) || p.url));
  // Every unseen post is remembered (so it isn't new again next week); the first few are read in full.
  const fresh = got.items.filter((i) => !known.has(normalizeUrl(i.url) || i.url)).slice(0, LIMITS.MAX_NEW_POSTS * 5);
  const updates: Partial<Competitor> = {
    news: { ...news, feedUrl: got.feedUrl, checkedAt: isoOf(nowMs) },
    nextPostsCheckAt: isoOf(nowMs + days(CADENCE.POSTS_DAYS)),
    lastPostsCheckAt: isoOf(nowMs),
    failures: 0,
    ...(c.problem === "news_unreachable" || c.problem === "blocked" || c.problem === "turned_away" ? { problem: null } : {}),
  };
  if (!fresh.length) return updates;

  // Read each new post for its title, description and date, while there is time and robots.txt allows.
  const robots = await robotsFor(new URL(news.url).origin, deps);
  const read: Array<FeedItem & { description: string }> = [];
  for (const [i, item] of fresh.entries()) {
    let { title, publishedAt } = item;
    let description = "";
    if (i < LIMITS.MAX_NEW_POSTS && deadlineMs - clock() > MODEL_MS && mayFetch(robots, item.url)) {
      const page = await fetchHtml(item.url, deps);
      if (page.ok) {
        const meta = readPostMeta(page.text, new Date(nowMs));
        title = title || meta.title;
        description = meta.description;
        publishedAt = publishedAt ?? meta.publishedAt;
      }
    }
    read.push({ url: item.url, title, publishedAt, description });
  }
  await recordNewPosts(ctx, c, read, nowMs, deadlineMs, deps);
  return updates;
}

/** New posts: kept, put into words while there is time (else by code), and shown as what changed. */
async function recordNewPosts(ctx: TenantContext, c: Competitor, read: Array<FeedItem & { description: string }>, nowMs: number, deadlineMs: number, deps: StepDeps): Promise<void> {
  await keepPosts(ctx, c, read, false, nowMs, deps);
  const words = await summarisePosts({ name: c.name, posts: read.map((p) => ({ title: p.title, description: p.description, url: p.url })) }, deadlineMs - clockOf(deps)() - MARGIN_MS, deps);
  await addChange(
    ctx,
    {
      competitorId: c.id,
      kind: "posts",
      at: isoOf(nowMs),
      headline: words.headline,
      summary: words.summary,
      topics: words.topics,
      posts: read.slice(0, LIMITS.MAX_NEW_POSTS).map((p) => ({ url: normalizeUrl(p.url) || p.url, title: p.title, publishedAt: p.publishedAt })),
      added: { count: read.length, sections: [] },
      removed: { count: 0, sections: [] },
      seenAt: null,
    },
    deps,
  );
}

