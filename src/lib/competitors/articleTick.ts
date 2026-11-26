import { randomUUID } from "node:crypto";
import { isGeminiConfigured, type AiUsage } from "@/lib/agents/gemini";
import { aiUsage, usageMeter } from "@/lib/plans/meter";
import { articleMapAtScale } from "@/lib/brandMap/articleScale";
import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { decidedBrandMap } from "@/lib/brandMap/store";
import { projectArticleMap, type ArticleMap } from "@/lib/content/blog/articleMap";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { forTenant } from "@/lib/tenant";
import { removeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import { listAllTenants } from "@/lib/tenant/registry";
import type { TenantContext } from "@/lib/tenant/types";
import type { BrandMap } from "@/lib/types/brandMap";
import { monthlyLimit } from "@/lib/plans/limits";
import { COMPETITOR_LIMITS as LIMITS, type ArticleProblem, type Competitor, type CompetitorArticle } from "@/lib/types/competitor";
import type { Tenant } from "@/lib/types/tenant";
import { MIN_ARTICLE_WORDS, readArticlePage } from "./article";
import { candidatesFrom, readArticle, readArticleWithGoogle, READER_VERSION, type ReadCandidates, type ReadDeps } from "./articleRead";
import {
  articlesToRead,
  articlesToRefresh,
  claimArticle,
  embedArticle,
  finishArticle,
  unindexArticle,
  monthOf,
  queueArticles,
  readsThisMonth,
  type ArticleStoreDeps,
} from "./articles";
import { fetchHtml, mayFetch, robotsFor, type FetchDeps } from "./fetch";
import { isCompetitorArticlesEnabled, isCompetitorsGoogleReaderEnabled } from "./flags";
import { listingCards } from "./feed";
import { datePosts, listPosts, newestFirst } from "./store";
import { cleanTitle } from "./titles";

/**
 * The article lane (COMPETITOR_ARTICLES_ENABLED). It rides the lifecycle tick beside the
 * competitor checks, every 2 minutes, and owns its own queue: the step machine never changes.
 *
 * Each tick it looks at each granted brand's watching competitors. When a competitor's posts were
 * checked since the lane last looked, it queues them: the newest 20 the first time, then only the
 * posts first seen since. Then it reads up to 3 queued articles across brands, side by side, each
 * under a lease. A brand stops at its monthly cap. A read starts only with enough time left to
 * finish, so a busy tick reads nothing rather than leaving a read half done.
 *
 * When nothing is waiting for a brand, a spare slot reads again an article an older reader read
 * (READER_VERSION), while the brand keeps REFRESH_RESERVE of its month's reads for new posts. A
 * read again that finds nothing keeps what the older reader found.
 */

export interface ArticleTickDeps extends ReadDeps, ArticleStoreDeps, FetchDeps {
  listTenants?: () => Promise<Tenant[]>;
  /** The brand's saved map (tests). */
  loadMap?: (ctx: TenantContext) => Promise<BrandMap | null>;
  /** The part of a moved map near an article (tests). */
  mapNear?: (ctx: TenantContext, map: BrandMap, text: string) => Promise<ArticleMap | null>;
  /** The usage (tests); otherwise the brand's own. */
  usage?: AiUsage;
}

export interface ArticleTickResult {
  tenants: number;
  queued: number;
  read: number;
  failed: number;
  skipped: number;
  /** Articles an older reader read, read again. */
  refreshed: number;
}

/** Reads started in one tick, across brands. */
const READS_PER_TICK = 3;
/** A read starts only with this much of the tick left: fetch, read, check, embed, save. */
const MIN_LEFT_MS = 35_000;
/** The longest one read may take. */
const READ_MS = 30_000;
/** Kept back from a read's time for checking and saving. */
const SAVE_MS = 3_000;
const TICK_MS = 120_000;
/** Reads a month kept for new posts: reading older articles again stops this far short of the cap. */
const REFRESH_RESERVE = 50;

/** The brand map, as one article sees it: the subjects and situations near it on a moved map, else all of it. */
async function mapFor(ctx: TenantContext, text: string, deps: ArticleTickDeps): Promise<ArticleMap | null> {
  const map = await (deps.loadMap ?? ((c) => decidedBrandMap(c, deps.db)))(ctx).catch(() => null);
  if (!map) return null;
  if (isBrandMapScaleEnabled() && map.moved) {
    const near = deps.mapNear ?? ((c, m, t) => articleMapAtScale(c, m, { ask: { text: t } }, { db: deps.db }));
    return near(ctx, map, text).catch(() => null);
  }
  return projectArticleMap(map);
}

async function candidatesFor(ctx: TenantContext, c: Competitor, brandName: string, text: string, deps: ArticleTickDeps): Promise<ReadCandidates> {
  const map = await mapFor(ctx, text.slice(0, 2000), deps);
  return candidatesFrom(map, { brandName, competitorNameId: c.nameId, competitorName: c.name });
}

/** Queue a competitor's posts when they were checked since the lane last looked. */
async function queueFor(ctx: TenantContext, c: Competitor, nowIso: string, deps: ArticleTickDeps): Promise<number> {
  const checked = c.lastPostsCheckAt ?? c.news?.baselineAt ?? null;
  if (c.status !== "watching" || c.googlePending?.length || !checked) return 0;
  const since = c.articlesScannedAt ?? null;
  if (since && checked <= since) return 0;
  const posts = (await listPosts(ctx, c.id, deps)).filter((p) => p.url);
  const pick = since ? posts.filter((p) => p.firstSeenAt > since) : [...posts].sort(newestFirst).slice(0, LIMITS.ARTICLE_BACKFILL);
  const added = await queueArticles(ctx, c.id, pick, deps);
  // Only the lane writes this field: the step machine's writes never touch it.
  await forTenant(ctx, deps.db).competitors.update(c.id, { articlesScannedAt: nowIso });
  return added;
}

/**
 * Once per competitor, after its first pick: when most of its stored posts have no date (a sitemap
 * without dates), date them from its news page's cards and queue its newest posts, so the first
 * pick's arbitrary order is put right. Marked done whatever happens, so it never runs twice.
 */
async function datePostsOnce(ctx: TenantContext, c: Competitor, nowIso: string, deps: ArticleTickDeps): Promise<number> {
  if (c.status !== "watching" || c.postsDatedAt || !c.articlesScannedAt) return 0;
  const done = () => forTenant(ctx, deps.db).competitors.update(c.id, { postsDatedAt: nowIso });
  const posts = (await listPosts(ctx, c.id, deps)).filter((p) => p.url);
  const undated = posts.filter((p) => !p.publishedAt).length;
  if (c.reader === "google" || !c.news?.url || !posts.length || undated * 2 < posts.length) {
    await done();
    return 0;
  }
  let dated = 0;
  try {
    const robots = await robotsFor(new URL(c.news.url).origin, deps);
    if (mayFetch(robots, c.news.url)) {
      const page = await fetchHtml(c.news.url, deps);
      if (page.ok) dated = await datePosts(ctx, c.id, listingCards(page.text, c.news.url, c.news.url, c.site, new Date((deps.clock ?? Date.now)())), deps);
    }
  } catch (err) {
    console.warn("[competitors] dating posts failed", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  await done();
  if (!dated) return 0;
  const newest = (await listPosts(ctx, c.id, deps)).filter((p) => p.url).sort(newestFirst).slice(0, LIMITS.ARTICLE_BACKFILL);
  return queueArticles(ctx, c.id, newest, deps);
}

type Outcome = "read" | "failed" | "skipped" | "again" | "kept";

/**
 * Close a read that saved nothing. A first read records why; a read again keeps what the older
 * reader found and is marked current, so it isn't tried again.
 */
async function unread(
  ctx: TenantContext,
  a: CompetitorArticle,
  leaseId: string,
  patch: Partial<CompetitorArticle>,
  outcome: Outcome,
  refresh: boolean,
  deps: ArticleTickDeps,
): Promise<Outcome> {
  if (refresh) {
    await finishArticle(ctx, a.id, leaseId, { status: "read", version: READER_VERSION[a.readBy ?? "direct"] }, deps);
    return "kept";
  }
  await finishArticle(ctx, a.id, leaseId, patch, deps);
  return outcome;
}

/** After a read that found nothing: once more later, else failed. A model call counts against the month. */
async function notRead(
  ctx: TenantContext,
  a: CompetitorArticle,
  leaseId: string,
  problem: ArticleProblem,
  modelCalled: boolean,
  refresh: boolean,
  deps: ArticleTickDeps,
): Promise<Outcome> {
  const last = a.attempts >= LIMITS.ARTICLE_ATTEMPTS;
  const patch = { status: last ? ("failed" as const) : ("queued" as const), problem, ...(modelCalled ? { readMonth: monthOf(new Date((deps.clock ?? Date.now)())) } : {}) };
  return unread(ctx, a, leaseId, patch, last ? "failed" : "again", refresh, deps);
}

/** Read one claimed article and save what it found. */
export async function readOneArticle(
  ctx: TenantContext,
  c: Competitor,
  a: CompetitorArticle,
  leaseId: string,
  brandName: string,
  deadlineMs: number,
  deps: ArticleTickDeps = {},
  opts: { refresh?: boolean } = {},
): Promise<Outcome> {
  const clock = deps.clock ?? Date.now;
  const now = new Date(clock());
  const refresh = Boolean(opts.refresh);
  const timeLeft = () => deadlineMs - clock() - SAVE_MS;
  const saved = (patch: Partial<CompetitorArticle> & { readBy: "direct" | "google" }) =>
    finishArticle(ctx, a.id, leaseId, { status: "read", problem: null, readAt: now.toISOString(), readMonth: monthOf(now), version: READER_VERSION[patch.readBy], ...patch }, deps);
  const stop = (patch: Partial<CompetitorArticle>, outcome: Outcome) => unread(ctx, a, leaseId, patch, outcome, refresh, deps);
  // A page that only lists other posts (a category or tag page) is no article: skipped, also on a
  // read again, and its meaning leaves the brand map's vectors.
  const listing = async (readBy: "direct" | "google") => {
    await finishArticle(ctx, a.id, leaseId, { status: "skipped", problem: "listing", readMonth: monthOf(now), version: READER_VERSION[readBy] }, deps);
    if (refresh) {
      await removeBrandMapVector(ctx, "competitor_article", a.id, deps.db).catch(() => undefined);
      // And from brand search, at once and forced (ADR-0023).
      await unindexArticle(ctx, a, deps);
    }
    return "skipped" as const;
  };
  const title = (t: string) => cleanTitle(t, [c.name, c.site]);
  const usage = deps.usage ?? aiUsage(ctx, "competitor_articles", { db: deps.db });
  // Each model call is one read on the meter, found or not, as the old counter counts it (modelCalled).
  const counted = () => usageMeter(ctx, "competitor_reads", "competitor_articles", { db: deps.db, now: () => new Date(clock()) }).record(1);

  if (c.reader === "google") {
    if (!isCompetitorsGoogleReaderEnabled() || (!deps.readWithGoogle && !isGeminiConfigured())) return stop({ status: "failed", problem: "turned_away" }, "failed");
    const cand = await candidatesFor(ctx, c, brandName, a.title, deps);
    const found = await readArticleWithGoogle(a.url, cand, { name: c.name, timeoutMs: Math.max(1, timeLeft()), usage }, deps);
    await counted();
    if (!found) return notRead(ctx, a, leaseId, "no_answer", true, refresh, deps);
    if (found.format === "listing") return listing("google");
    const done = await saved({ readBy: "google", title: title(a.title), ...found });
    if (done) await embedArticle(ctx, done, deps, c);
    return done ? "read" : "failed";
  }

  let origin: string;
  try {
    origin = new URL(a.url).origin;
  } catch {
    return stop({ status: "skipped", problem: "unreachable" }, "skipped");
  }
  const robots = await robotsFor(origin, deps);
  if (!mayFetch(robots, a.url)) return stop({ status: "skipped", problem: "blocked" }, "skipped");
  const got = await fetchHtml(a.url, deps);
  if (!got.ok) {
    if (got.reason === "not_found") return stop({ status: "skipped", problem: "removed" }, "skipped");
    return notRead(ctx, a, leaseId, got.reason === "turned_away" ? "turned_away" : "unreachable", false, refresh, deps);
  }
  const page = readArticlePage(got.text, got.url, c.site, now);
  if (page.words < MIN_ARTICLE_WORDS) return stop({ status: "skipped", problem: "not_an_article", words: page.words }, "skipped");
  const cand = await candidatesFor(ctx, c, brandName, [page.title, page.description, ...page.headings].join("\n"), deps);
  const found = await readArticle(page, cand, { name: c.name, timeoutMs: Math.max(1, timeLeft()), usage }, deps);
  await counted();
  if (!found) return notRead(ctx, a, leaseId, "no_answer", true, refresh, deps);
  if (found.format === "listing") return listing("direct");
  const done = await saved({
    readBy: "direct",
    title: title(a.title || page.title),
    publishedAt: a.publishedAt ?? page.trust.publishedAt,
    words: page.words,
    headings: page.headings,
    trust: page.trust,
    ...found,
  });
  if (done) await embedArticle(ctx, done, deps, c);
  return done ? "read" : "failed";
}

export async function runArticleReads(opts: { deadlineMs: number }, deps: ArticleTickDeps = {}): Promise<ArticleTickResult> {
  const result: ArticleTickResult = { tenants: 0, queued: 0, read: 0, failed: 0, skipped: 0, refreshed: 0 };
  if (!isCompetitorArticlesEnabled()) return result;
  const clock = deps.clock ?? Date.now;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => tenantMayUse(t, "competitors") && tenantMayUse(t, "competitor_articles"));
  // Take turns across brands, starting somewhere new each tick.
  const offset = tenants.length ? Math.floor(clock() / TICK_MS) % tenants.length : 0;
  const order = [...tenants.slice(offset), ...tenants.slice(0, offset)];

  const reads: Array<Promise<void>> = [];
  for (const t of order) {
    if (opts.deadlineMs - clock() < MIN_LEFT_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const competitors = await forTenant(ctx, deps.db).competitors.find({ limit: LIMITS.MAX_PER_BRAND * 2 });
      result.tenants += 1;
      const nowIso = new Date(clock()).toISOString();
      for (const c of competitors) {
        result.queued += await queueFor(ctx, c, nowIso, deps);
        if (opts.deadlineMs - clock() >= MIN_LEFT_MS) result.queued += await datePostsOnce(ctx, c, nowIso, deps);
      }
      if (reads.length >= READS_PER_TICK) continue;
      const month = await readsThisMonth(ctx, deps);
      const cap = monthlyLimit(t, "competitor_articles");
      if (month >= cap) continue;

      // Only competitors still watched: a paused one's articles wait.
      const watching = new Map(competitors.filter((c) => c.status === "watching").map((c) => [c.id, c]));
      const watched = (a: CompetitorArticle) => watching.has(a.competitorId);
      const waiting = (await articlesToRead(ctx, READS_PER_TICK * 3, deps)).filter(watched);
      // Nothing new waiting: a spare slot reads again what an older reader read, short of the cap.
      const refresh = !waiting.length && month < cap - REFRESH_RESERVE;
      const next = refresh ? await articlesToRefresh(ctx, READS_PER_TICK * 3, watched, deps) : waiting;
      for (const a of next) {
        if (reads.length >= READS_PER_TICK || opts.deadlineMs - clock() < MIN_LEFT_MS) break;
        const leaseId = randomUUID();
        const mine = await claimArticle(ctx, a.id, leaseId, deps, { refresh });
        if (!mine) continue;
        const deadline = Math.min(opts.deadlineMs, clock() + READ_MS);
        reads.push(
          readOneArticle(ctx, watching.get(a.competitorId)!, mine, leaseId, t.tenantName, deadline, deps, { refresh })
            .then((outcome) => {
              if (outcome === "read") result[refresh ? "refreshed" : "read"] += 1;
              else if (outcome === "skipped") result.skipped += 1;
              else if (outcome === "failed") result.failed += 1;
            })
            .catch((err: unknown) => {
              result.failed += 1;
              console.warn(`[competitors] ${t.id} article ${a.id} read failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
            }),
        );
      }
    } catch (err) {
      console.warn(`[competitors] tenant ${t.id} (${t.region}) articles failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  await Promise.all(reads);
  return result;
}
