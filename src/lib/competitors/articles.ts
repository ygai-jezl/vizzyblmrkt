import { embedDocuments, embedQuery } from "@/lib/agents/embeddings";
import { forTenant } from "@/lib/tenant";
import { nearestBrandMapRecords, removeBrandMapVector, writeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { COMPETITOR_LIMITS as LIMITS, type CompetitorArticle, type CompetitorPost } from "@/lib/types/competitor";
import { readByOlderReader } from "./articleRead";

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

/** Articles an older reader read, newest first, of the competitors `keep` allows: read again when nothing new is waiting. */
export async function articlesToRefresh(
  ctx: TenantContext,
  limit: number,
  keep: (a: CompetitorArticle) => boolean,
  deps: ArticleStoreDeps = {},
): Promise<CompetitorArticle[]> {
  const read = await repoOf(ctx, deps).find({ where: [["status", "==", "read"]], limit: 300 });
  return read.filter((a) => keep(a) && readByOlderReader(a)).sort(newest).slice(0, limit);
}

/**
 * Take an article to read. Null when another run has it, or it was read or removed meanwhile.
 * `refresh` takes an article an older reader read instead; reading it again isn't a new attempt.
 */
export async function claimArticle(
  ctx: TenantContext,
  id: string,
  leaseId: string,
  deps: ArticleStoreDeps = {},
  opts: { refresh?: boolean } = {},
): Promise<CompetitorArticle | null> {
  const nowMs = nowOf(deps).getTime();
  return repoOf(ctx, deps).claim(id, (cur) => {
    const lease = { status: "reading" as const, leaseId, leaseUntil: new Date(nowMs + ARTICLE_LEASE_MS).toISOString() };
    if (opts.refresh) return readByOlderReader(cur) ? lease : null;
    const free = cur.status === "queued" || (cur.status === "reading" && (!cur.leaseUntil || Date.parse(cur.leaseUntil) <= nowMs));
    return free ? { ...lease, attempts: cur.attempts + 1 } : null;
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
