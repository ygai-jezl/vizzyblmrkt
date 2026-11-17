import { embedDocuments, embedQuery } from "@/lib/agents/embeddings";
import { forTenant } from "@/lib/tenant";
import { nearestBrandMapRecords, removeBrandMapVector, writeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { COMPETITOR_LIMITS as LIMITS, type CompetitorArticle, type CompetitorPost } from "@/lib/types/competitor";

/**
 * Their articles, stored (COMPETITOR_ARTICLES_ENABLED). One record per post we read, with the
 * post's id, in `competitor_articles`. A record is its own queue item: `queued`, then `reading`
 * under a lease (so two runs never read the same article), then `read`, `failed` or `skipped`.
 *
 * Every query here is an equality on one field (beside the brand), so none needs a composite
 * index. Totals are worked out from the records when a page asks, never stored, so two runs can't
 * lose a count.
 */

export interface ArticleStoreDeps {
  db?: FirestoreLike;
  now?: () => Date;
  /** Test seams. */
  embed?: typeof embedDocuments;
  query?: typeof embedQuery;
  vectors?: KnowledgeCollectionLike;
}

/** How long one read may hold an article before another run may take it. */
export const ARTICLE_LEASE_MS = 90_000;
/** Records read for a brand's totals or a competitor's list, at most. */
const LIST_MAX = 1_500;

const repoOf = (ctx: TenantContext, deps: ArticleStoreDeps) => forTenant(ctx, deps.db).competitorArticles;
const nowOf = (deps: ArticleStoreDeps) => (deps.now ?? (() => new Date()))();

/** "2026-11": the month a read counts against. */
export const monthOf = (d: Date) => d.toISOString().slice(0, 7);

const newest = (a: CompetitorArticle, b: CompetitorArticle) =>
  (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || b.queuedAt.localeCompare(a.queuedAt);

function queued(competitorId: string, post: Pick<CompetitorPost, "url" | "title" | "publishedAt">, at: string): Omit<CompetitorArticle, "id" | "tenantId"> {
  return {
    competitorId,
    url: post.url,
    title: post.title,
    publishedAt: post.publishedAt,
    status: "queued",
    problem: null,
    attempts: 0,
    leaseUntil: null,
    leaseId: null,
    queuedAt: at,
    readAt: null,
    readMonth: null,
    readBy: null,
    version: 0,
    summary: "",
    question: "",
    angle: "",
    newTopic: null,
    format: null,
    stage: null,
    subjectIds: [],
    situationIds: [],
    audienceIds: [],
    reader: { roles: [], companies: "", pains: [] },
    words: 0,
    headings: [],
    stats: [],
    sources: [],
    links: [],
    asks: [],
    trust: { author: null, authorUrl: null, publishedAt: null, updatedAt: null, schemaTypes: [] },
    mentions: { you: [], others: [], products: [] },
  };
}

/** Queue posts to be read. A post already queued (or read) is left alone. Returns how many were added. */
export async function queueArticles(ctx: TenantContext, competitorId: string, posts: CompetitorPost[], deps: ArticleStoreDeps = {}): Promise<number> {
  const repo = repoOf(ctx, deps);
  const at = nowOf(deps).toISOString();
  let added = 0;
  for (const post of posts) {
    if (post.competitorId !== competitorId || (await repo.getById(post.id))) continue;
    try {
      await repo.create(post.id, queued(competitorId, post, at));
      added += 1;
    } catch {
      // Another run queued it first.
    }
  }
  return added;
}

/** Articles waiting to be read, newest first: queued ones, and any whose reader stopped without finishing. */
export async function articlesToRead(ctx: TenantContext, limit: number, deps: ArticleStoreDeps = {}): Promise<CompetitorArticle[]> {
  const repo = repoOf(ctx, deps);
  const nowMs = nowOf(deps).getTime();
  const [waiting, reading] = await Promise.all([
    repo.find({ where: [["status", "==", "queued"]], limit: 200 }),
    repo.find({ where: [["status", "==", "reading"]], limit: 50 }),
  ]);
  const stuck = reading.filter((a) => !a.leaseUntil || Date.parse(a.leaseUntil) <= nowMs);
  return [...waiting, ...stuck].sort(newest).slice(0, limit);
}

/** Take an article to read. Null when another run has it, or it was read or removed meanwhile. */
export async function claimArticle(ctx: TenantContext, id: string, leaseId: string, deps: ArticleStoreDeps = {}): Promise<CompetitorArticle | null> {
  const nowMs = nowOf(deps).getTime();
  return repoOf(ctx, deps).claim(id, (cur) => {
    const free = cur.status === "queued" || (cur.status === "reading" && (!cur.leaseUntil || Date.parse(cur.leaseUntil) <= nowMs));
    return free ? { status: "reading", leaseId, leaseUntil: new Date(nowMs + ARTICLE_LEASE_MS).toISOString(), attempts: cur.attempts + 1 } : null;
  });
}

/** Save what a read found, only while this run still holds the article (a competitor removed meanwhile stays removed). */
export async function finishArticle(
  ctx: TenantContext,
  id: string,
  leaseId: string,
  patch: Partial<Omit<CompetitorArticle, "id" | "tenantId" | "leaseId" | "leaseUntil">>,
  deps: ArticleStoreDeps = {},
): Promise<CompetitorArticle | null> {
  return repoOf(ctx, deps).claim(id, (cur) => (cur.status === "reading" && cur.leaseId === leaseId ? { ...patch, leaseId: null, leaseUntil: null } : null));
}

/** Reads this calendar month (each was a Gemini call), against the brand's cap. */
export async function readsThisMonth(ctx: TenantContext, deps: ArticleStoreDeps = {}): Promise<number> {
  return repoOf(ctx, deps).count([["readMonth", "==", monthOf(nowOf(deps))]]);
}

export async function monthlyCapReached(ctx: TenantContext, deps: ArticleStoreDeps = {}): Promise<boolean> {
  return (await readsThisMonth(ctx, deps)) >= LIMITS.ARTICLE_READS_PER_MONTH;
}

/** One competitor's articles, newest first. */
export async function listArticles(ctx: TenantContext, competitorId: string, deps: ArticleStoreDeps = {}): Promise<CompetitorArticle[]> {
  return (await repoOf(ctx, deps).find({ where: [["competitorId", "==", competitorId]], limit: LIST_MAX })).sort(newest);
}

/** Every article the brand has read, newest first. */
export async function listReadArticles(ctx: TenantContext, deps: ArticleStoreDeps = {}): Promise<CompetitorArticle[]> {
  return (await repoOf(ctx, deps).find({ where: [["status", "==", "read"]], limit: LIST_MAX })).sort(newest);
}

/** Articles read on one of the brand's subjects, newest first. */
export async function articlesOnSubject(ctx: TenantContext, subjectId: string, deps: ArticleStoreDeps = {}): Promise<CompetitorArticle[]> {
  const found = await repoOf(ctx, deps).find({ where: [["subjectIds", "array-contains", subjectId]], limit: 200 });
  return found.filter((a) => a.status === "read").sort(newest);
}

/** Stop watching: a competitor's articles and their vectors go too. */
export async function removeArticles(ctx: TenantContext, competitorId: string, deps: ArticleStoreDeps = {}): Promise<number> {
  const repo = repoOf(ctx, deps);
  const rows = await repo.find({ where: [["competitorId", "==", competitorId]], limit: 5_000 });
  for (const a of rows) if (a.status === "read") await removeBrandMapVector(ctx, "competitor_article", a.id, deps.db).catch(() => undefined);
  return repo.deleteWhere([["competitorId", "==", competitorId]]);
}

// ---------------------------------------------------------------------------------------------
// Meaning: each read article sits beside the brand map's vectors
// ---------------------------------------------------------------------------------------------

const articleText = (a: Pick<CompetitorArticle, "title" | "question" | "angle" | "summary">) =>
  [a.title, a.question, a.angle, a.summary].filter((s) => s?.trim()).join("\n");

/** Embed what an article covers (best effort: a read is kept even when this fails). */
export async function embedArticle(
  ctx: TenantContext,
  a: Pick<CompetitorArticle, "id" | "title" | "question" | "angle" | "summary">,
  deps: ArticleStoreDeps = {},
): Promise<boolean> {
  try {
    const [vector] = await (deps.embed ?? embedDocuments)([{ content: articleText(a), title: "Competitor article" }], ctx.region);
    if (!vector) return false;
    await writeBrandMapVector(ctx, { kind: "competitor_article", ref: a.id, status: "kept" }, vector, deps.db);
    return true;
  } catch (err) {
    console.warn("[competitors] embedding an article failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return false;
  }
}

/** Competitor articles nearest some text in meaning, most similar first; [] when embeddings are down. */
export async function nearestCompetitorArticles(
  ctx: TenantContext,
  text: string,
  opts: { limit: number; minSim?: number },
  deps: ArticleStoreDeps = {},
): Promise<Array<{ article: CompetitorArticle; sim: number }>> {
  const vector = await (deps.query ?? embedQuery)(text.slice(0, 2000), ctx.region).catch(() => null);
  if (!vector) return [];
  const near = await nearestBrandMapRecords(ctx, { kind: "competitor_article", vector, limit: opts.limit, statuses: ["kept"], minSim: opts.minSim }, deps.vectors).catch(
    () => [],
  );
  const repo = repoOf(ctx, deps);
  const found = await Promise.all(near.map(async (n) => ({ article: await repo.getById(n.ref), sim: n.sim })));
  return found.filter((f): f is { article: CompetitorArticle; sim: number } => f.article?.status === "read");
}

// ---------------------------------------------------------------------------------------------
// Totals, for the page (worked out on read)
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
