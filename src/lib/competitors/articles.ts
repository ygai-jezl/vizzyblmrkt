import { embedDocuments, embedQuery } from "@/lib/agents/embeddings";
import { articleIdOfRef, competitorArticleRef, competitorArticleSource } from "@/lib/search/family";
import { embedForFamily, indexFamily, nearestFamily, removeFamily, type FamilyDeps } from "@/lib/search/familyIndex";
import { isOldVectorsRetired, isSearchCompetitorReadsEnabled, isSearchFamilyIndexEnabled } from "@/lib/search/flags";
import { forTenant } from "@/lib/tenant";
import { nearestBrandMapRecords, removeBrandMapVector, writeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import type { FirestoreLike, KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { brandMonthlyLimit } from "@/lib/plans/limits";
import type { Competitor, CompetitorArticle, CompetitorPost } from "@/lib/types/competitor";
import type { Tenant } from "@/lib/types/tenant";
import { readByOlderReader } from "./articleRead";

/**
 * Their articles, stored (COMPETITOR_ARTICLES_ENABLED). One record per post we read, with the
 * post's id, in `competitor_articles`. A record is its own queue item: `queued`, then `reading`
 * under a lease (so two runs never read the same article), then `read`, `failed` or `skipped`.
 *
 * Every query here is an equality on one field (beside the brand), so none needs a composite
 * index. Totals are worked out from the records when a page asks, never stored, so two runs can't
 * lose a count.
 *
 * Meaning (ADR-0025): a read article is embedded in brand_map_vectors and, with
 * SEARCH_FAMILY_INDEX_ENABLED, in brand search (kind competitor, ref {competitorId}/{articleId},
 * status kept). With SEARCH_COMPETITOR_READS_ENABLED the readers use brand search only, and keep
 * only refs with a slash: a competitor's own summary never answers "which article covers this".
 */

export interface ArticleStoreDeps extends FamilyDeps {
  db?: FirestoreLike;
  now?: () => Date;
  /** Test seams. */
  embed?: typeof embedDocuments;
  query?: typeof embedQuery;
  vectors?: KnowledgeCollectionLike;
  /** Reads the brand record for its cap (src/lib/plans/limits.ts). */
  loadTenant?: (id: string) => Promise<Tenant | null>;
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

/** Reads this calendar month (each was a Gemini call), against the brand's cap (src/lib/plans/limits.ts). */
export async function readsThisMonth(ctx: TenantContext, deps: ArticleStoreDeps = {}): Promise<number> {
  return repoOf(ctx, deps).count([["readMonth", "==", monthOf(nowOf(deps))]]);
}

/** Months read back for the last 90 days: this month and the 3 before always hold them. */
export const RECENT_MONTHS = 4;
/** Records looked at per month, at most, whatever a brand's cap: the most one page asks for. */
export const MONTH_CEILING = 1_000;
/** Above the brand's cap: a month also holds failed and skipped reads, and two runs can pass the cap together. */
const MONTH_MARGIN = 50;

/**
 * The articles read this month and the 3 before, newest first: one equality query per month on the
 * month a read counts against, as readsThisMonth's, so no index is needed. The query also finds
 * failed and skipped records, so only read ones are kept here. Each month reads up to the brand's
 * monthly cap (and a margin, never more than MONTH_CEILING); `truncated` says a month had more,
 * so counts made from these may be low. An article is read after it is published, so every one
 * published in the last 90 days was read in one of these months.
 */
export async function listRecentReadArticles(ctx: TenantContext, deps: ArticleStoreDeps = {}): Promise<{ articles: CompetitorArticle[]; truncated: boolean }> {
  const now = nowOf(deps);
  const months = Array.from({ length: RECENT_MONTHS }, (_, i) => monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  const cap = await brandMonthlyLimit(ctx, "competitor_articles", deps.loadTenant).catch(() => MONTH_CEILING);
  const limit = Math.min(MONTH_CEILING, Math.max(1, cap) + MONTH_MARGIN);
  const repo = repoOf(ctx, deps);
  const rows = await Promise.all(months.map((m) => repo.find({ where: [["readMonth", "==", m]], limit })));
  const seen = new Set<string>();
  const articles = rows
    .flat()
    .filter((a) => a.status === "read" && !seen.has(a.id) && Boolean(seen.add(a.id)))
    .sort(newest);
  return { articles, truncated: rows.some((r) => r.length >= limit) };
}

export async function monthlyCapReached(ctx: TenantContext, deps: ArticleStoreDeps = {}): Promise<boolean> {
  const cap = await brandMonthlyLimit(ctx, "competitor_articles", deps.loadTenant);
  return (await readsThisMonth(ctx, deps)) >= cap;
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

/**
 * Articles read that fitted no subject when read, and whose topic is this subject's name: the
 * ones a subject added from "They write about these" came from. Newest first.
 */
export async function articlesOnTopic(ctx: TenantContext, name: string, deps: ArticleStoreDeps = {}): Promise<CompetitorArticle[]> {
  const topic = name.trim();
  if (!topic) return [];
  const found = await repoOf(ctx, deps).find({ where: [["newTopic", "==", topic]], limit: 200 });
  return found.filter((a) => a.status === "read").sort(newest);
}

/**
 * A subject added from a topic they write about: the read articles that fitted no subject and
 * whose topic (by `keyOf`) is now a subject are put on it, so its box finds them. Returns how many.
 */
export async function linkTopicArticles(
  ctx: TenantContext,
  subjectByKey: Map<string, string>,
  keyOf: (topic: string) => string,
  deps: ArticleStoreDeps = {},
): Promise<number> {
  if (!subjectByKey.size) return 0;
  const repo = repoOf(ctx, deps);
  let linked = 0;
  for (const a of await listReadArticles(ctx, deps)) {
    const id = a.newTopic && !a.subjectIds.length ? subjectByKey.get(keyOf(a.newTopic)) : undefined;
    if (!id) continue;
    await repo.update(a.id, { subjectIds: [id] });
    linked += 1;
  }
  return linked;
}

/**
 * Stop watching: a competitor's articles and their vectors go too, and their entries in brand
 * search (with the competitor's summary) at once, forced, whatever any switch says.
 */
export async function removeArticles(ctx: TenantContext, competitorId: string, deps: ArticleStoreDeps = {}): Promise<number> {
  const repo = repoOf(ctx, deps);
  const rows = await repo.find({ where: [["competitorId", "==", competitorId]], limit: 5_000 });
  const read = rows.filter((a) => a.status === "read");
  for (const a of read) await removeBrandMapVector(ctx, "competitor_article", a.id, deps.db).catch(() => undefined);
  await removeFamily(ctx, "competitor", [competitorId, ...read.map((a) => competitorArticleRef(competitorId, a.id))], deps);
  return repo.deleteWhere([["competitorId", "==", competitorId]]);
}

// ---------------------------------------------------------------------------------------------
// Meaning: each read article sits beside the brand map's vectors
// ---------------------------------------------------------------------------------------------

const articleText = (a: Pick<CompetitorArticle, "title" | "question" | "angle" | "summary">) =>
  [a.title, a.question, a.angle, a.summary].filter((s) => s?.trim()).join("\n");

/**
 * Embed what an article covers (best effort: a read is kept even when this fails), in both stores
 * (ADR-0025). Brand search titles it with its competitor's name, read when not given.
 */
export async function embedArticle(
  ctx: TenantContext,
  a: Pick<CompetitorArticle, "id" | "competitorId" | "title" | "question" | "angle" | "summary">,
  deps: ArticleStoreDeps = {},
  competitor?: Pick<Competitor, "id" | "name">,
): Promise<boolean> {
  let indexed = false;
  if (isSearchFamilyIndexEnabled()) {
    const c = competitor ?? (await forTenant(ctx, deps.db).competitors.getById(a.competitorId).catch(() => null));
    const src = c ? competitorArticleSource(c, a, { family: true }) : null;
    if (src) indexed = Boolean((await indexFamily(ctx, [src], deps))[0]?.vector);
  }
  // Retired (ADR-0025): nothing is embedded for brand_map_vectors.
  if (isOldVectorsRetired()) return indexed;
  try {
    const [vector] = await (deps.embed ?? embedDocuments)([{ content: articleText(a), title: "Competitor article" }], ctx.region);
    if (!vector) return indexed;
    await writeBrandMapVector(ctx, { kind: "competitor_article", ref: a.id, status: "kept" }, vector, deps.db);
    return true;
  } catch (err) {
    console.warn("[competitors] embedding an article failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return indexed;
  }
}

/** An article's entry in brand search taken out at once, forced (a listing page read again). */
export async function unindexArticle(ctx: TenantContext, a: Pick<CompetitorArticle, "id" | "competitorId">, deps: ArticleStoreDeps = {}): Promise<void> {
  await removeFamily(ctx, "competitor", [competitorArticleRef(a.competitorId, a.id)], deps);
}

/** Article ids among brand search's competitor hits: only refs with a slash, never a summary. */
const articleHits = (hits: Array<{ ref: string; score: number }>) =>
  hits.flatMap((h) => {
    const id = articleIdOfRef(h.ref);
    return id ? [{ ref: id, sim: h.score }] : [];
  });

/**
 * Which of these questions no competitor article is near in meaning (their ids, in order). Null when
 * meaning can't be checked for one of them: nothing is called uncovered by mistake.
 */
export async function questionsNobodyCovers(
  ctx: TenantContext,
  questions: Array<{ id: string; text: string }>,
  minSim: number,
  deps: ArticleStoreDeps = {},
): Promise<string[] | null> {
  if (isSearchCompetitorReadsEnabled()) {
    const vectors = await embedForFamily(ctx, questions.map((q) => q.text), { query: true }, deps);
    const checked = await Promise.all(
      questions.map(async (q, i) => {
        const vector = vectors[i];
        if (!vector) return null;
        const near = await nearestFamily(ctx, ["competitor"], vector, { statuses: ["kept"], limit: 1, minScore: minSim, keep: (h) => articleIdOfRef(h.ref) !== null }, deps).catch(() => null);
        return near ? { id: q.id, covered: near.length > 0 } : null;
      }),
    );
    if (checked.some((c) => c === null)) return null;
    return checked.flatMap((c) => (c && !c.covered ? [c.id] : []));
  }
  const checked = await Promise.all(
    questions.map(async (q) => {
      const vector = await (deps.query ?? embedQuery)(q.text.slice(0, 2000), ctx.region).catch(() => null);
      if (!vector) return null;
      const near = await nearestBrandMapRecords(ctx, { kind: "competitor_article", vector, limit: 1, statuses: ["kept"], minSim }, deps.vectors).catch(() => null);
      return near ? { id: q.id, covered: near.length > 0 } : null;
    }),
  );
  if (checked.some((c) => c === null)) return null;
  return checked.flatMap((c) => (c && !c.covered ? [c.id] : []));
}

/** Competitor articles nearest some text in meaning, most similar first; [] when embeddings are down. */
export async function nearestCompetitorArticles(
  ctx: TenantContext,
  text: string,
  opts: { limit: number; minSim?: number },
  deps: ArticleStoreDeps = {},
): Promise<Array<{ article: CompetitorArticle; sim: number }>> {
  const onIndex = isSearchCompetitorReadsEnabled();
  const [vector] = onIndex ? await embedForFamily(ctx, [text], { query: true }, deps) : [await (deps.query ?? embedQuery)(text.slice(0, 2000), ctx.region).catch(() => null)];
  if (!vector) return [];
  const near = onIndex
    ? articleHits(await nearestFamily(ctx, ["competitor"], vector, { statuses: ["kept"], limit: opts.limit, minScore: opts.minSim, keep: (h) => articleIdOfRef(h.ref) !== null }, deps).catch(() => []))
    : await nearestBrandMapRecords(ctx, { kind: "competitor_article", vector, limit: opts.limit, statuses: ["kept"], minSim: opts.minSim }, deps.vectors).catch(() => []);
  const repo = repoOf(ctx, deps);
  const found = await Promise.all(near.map(async (n) => ({ article: await repo.getById(n.ref), sim: n.sim })));
  return found.filter((f): f is { article: CompetitorArticle; sim: number } => f.article?.status === "read");
}
