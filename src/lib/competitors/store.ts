import { createHash, randomUUID } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { assertSafeHttpsUrl } from "@/lib/security/ssrf";
import { siteOf } from "@/lib/knowledge/site";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { addBrandMapName, readBrandMap } from "@/lib/brandMap/store";
import { findName } from "@/lib/brandMap/changes";
import {
  COMPETITOR_LIMITS as LIMITS,
  type Competitor,
  type CompetitorChange,
  type CompetitorPatch,
  type CompetitorPost,
  type MonitorInput,
} from "@/lib/types/competitor";
import { removeArticles } from "./articles";
import { chunkLines, line, onSite, pagesFromChunks, type BaselinePage } from "./sitemap";

/**
 * Competitors' storage, all through forTenant(ctx): one document per competitor, its baseline as
 * chunk documents by generation, the posts seen on its news page and what changed. Every query is
 * equality only (no composite index): bounded lists are read whole and sorted here.
 */

export interface StoreDeps {
  db?: FirestoreLike;
  now?: () => Date;
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string; id?: string; issues?: Array<{ path: string; message: string }> };

const repoOf = (ctx: TenantContext, deps: StoreDeps) => forTenant(ctx, deps.db);
export const nowOf = (deps: StoreDeps) => (deps.now ?? (() => new Date()))();

const ID = /^cmp_[a-z0-9]{8,40}$/;
export const isCompetitorId = (id: string) => ID.test(id);

/**
 * A website as a person typed it, as the https origin we read from. "acme.example",
 * "http://acme.example/about" and "https://www.acme.example" are all fine; anything that isn't a
 * public https site is refused with words for why.
 */
export function websiteOf(raw: string): { ok: true; origin: string; site: string } | { ok: false; error: string } {
  let text = (raw ?? "").trim();
  if (!text) return { ok: false, error: "website_required" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  text = text.replace(/^http:\/\//i, "https://");
  let url: URL;
  try {
    url = assertSafeHttpsUrl(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : "";
    return { ok: false, error: why === "scheme_not_https" ? "website_not_https" : "website_invalid" };
  }
  const site = siteOf(url.hostname);
  if (!site || !url.hostname.includes(".")) return { ok: false, error: "website_invalid" };
  return { ok: true, origin: url.origin, site };
}

export async function listCompetitors(ctx: TenantContext, deps: StoreDeps = {}): Promise<Competitor[]> {
  const rows = await repoOf(ctx, deps).competitors.find({ limit: 50 });
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function getCompetitor(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<Competitor | null> {
  if (!isCompetitorId(id)) return null;
  return repoOf(ctx, deps).competitors.getById(id);
}

function blank(
  input: { name: string; origin: string; site: string; by: string | null; nameId: string | null; group?: Competitor["group"] },
  now: string,
): Omit<Competitor, "id" | "tenantId"> {
  return {
    name: input.name,
    website: input.origin,
    site: input.site,
    nameId: input.nameId,
    status: "finding",
    stage: "plain",
    problem: null,
    failures: 0,
    sitemap: null,
    read: null,
    analysis: null,
    relabel: false,
    news: null,
    nextPostsCheckAt: null,
    nextSiteCheckAt: null,
    lastPostsCheckAt: null,
    lastSiteCheckAt: null,
    leaseUntil: null,
    leaseId: null,
    addedBy: input.by,
    // Only a group someone chose is kept: a record made while it is off has no group field.
    ...(input.group ? { group: input.group } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export interface Monitored {
  competitor: Competitor;
  /** What happened on the brand map (null when the brand map is off). */
  brandMap: "added" | "already" | "suggested" | "not_added" | null;
}

/**
 * Start watching a competitor. One per site per brand, at most MAX_PER_BRAND. Its name goes on
 * the brand map's alternatives (addBrandMapName); a brand map that is off or refuses it never
 * stops the watching. A group, when given, is the finder's (the caller leaves it out while
 * STRATEGY_COMPETITORS_ENABLED is off).
 */
export async function monitorCompetitor(ctx: TenantContext, input: MonitorInput, deps: StoreDeps = {}): Promise<Result<Monitored>> {
  const site = websiteOf(input.website);
  if (!site.ok) return { ok: false, status: 400, error: site.error };
  const repo = repoOf(ctx, deps).competitors;
  const same = await repo.find({ where: [["website", "==", site.origin]], limit: 1 });
  if (same[0]) return { ok: false, status: 409, error: "already_watching", id: same[0].id };
  const all = await repo.find({ limit: LIMITS.MAX_PER_BRAND + 1 });
  if (all.some((c) => c.site === site.site)) return { ok: false, status: 409, error: "already_watching", id: all.find((c) => c.site === site.site)!.id };
  if (all.length >= LIMITS.MAX_PER_BRAND) return { ok: false, status: 409, error: "too_many" };

  const map = await addBrandMapName(ctx, { name: input.name }, { db: deps.db, nowMs: nowOf(deps).getTime() }).catch(() => null);
  const brandMap: Monitored["brandMap"] = !map ? "not_added" : map.ok ? map.value.how : map.error === "brand_map_disabled" ? null : "not_added";
  const nameId = map?.ok ? map.value.nameId : null;

  const now = nowOf(deps).toISOString();
  const id = `cmp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const competitor = await repo.create(id, blank({ name: input.name, origin: site.origin, site: site.site, by: ctx.email ?? ctx.userId ?? null, nameId, group: input.group ?? null }, now));
  return { ok: true, value: { competitor, brandMap } };
}

/** Add a competitor's name to the brand map again (it was removed there, or never added). */
export async function addToBrandMap(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<Result<Monitored>> {
  const c = await getCompetitor(ctx, id, deps);
  if (!c) return { ok: false, status: 404, error: "not_found" };
  const map = await addBrandMapName(ctx, { name: c.name }, { db: deps.db, nowMs: nowOf(deps).getTime() });
  if (!map.ok) return { ok: false, status: map.status, error: map.error, ...(map.issues ? { issues: map.issues } : {}) };
  await repoOf(ctx, deps).competitors.update(id, { nameId: map.value.nameId, updatedAt: nowOf(deps).toISOString() });
  return { ok: true, value: { competitor: { ...c, nameId: map.value.nameId }, brandMap: map.value.how } };
}

/**
 * The names of the brand's competitors that are on its brand map, by name or another spelling
 * (never by id: a person saving an older copy of the map can drop a name we added).
 */
export async function onBrandMap(ctx: TenantContext, competitors: Competitor[], deps: StoreDeps = {}): Promise<Set<string>> {
  const read = await readBrandMap(ctx, deps.db).catch(() => ({ state: "none" as const }));
  if (read.state !== "ok") return new Set();
  return new Set(competitors.filter((c) => findName(read.map, c.name)).map((c) => c.id));
}

/**
 * A person's change: rename, choose the news page or the sitemap, pause or resume, or put it in a
 * group (null: not grouped). The caller leaves `group` out while STRATEGY_COMPETITORS_ENABLED is off.
 */
export async function updateCompetitor(ctx: TenantContext, id: string, patch: CompetitorPatch, deps: StoreDeps = {}): Promise<Result<Competitor>> {
  const c = await getCompetitor(ctx, id, deps);
  if (!c) return { ok: false, status: 404, error: "not_found" };
  const now = nowOf(deps).toISOString();
  const next: Partial<Competitor> = { updatedAt: now };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.group !== undefined) next.group = patch.group;
  if (patch.newsUrl !== undefined) {
    const url = pageOnSite(patch.newsUrl, c.site);
    if (!url) return { ok: false, status: 400, error: "not_on_their_site" };
    next.news = { url, feedUrl: null, chosenBy: "manual", baselineAt: null, checkedAt: null };
    next.nextPostsCheckAt = now;
    if (c.problem === "no_news_page" || c.problem === "news_unreachable" || c.problem === "blocked" || c.problem === "turned_away") next.problem = null;
    if (c.status === "needs_you") Object.assign(next, { status: "watching", stage: null, failures: 0, problem: null });
  }
  if (patch.sitemapUrl !== undefined) {
    const url = pageOnSite(patch.sitemapUrl, c.site);
    if (!url) return { ok: false, status: 400, error: "not_on_their_site" };
    Object.assign(next, {
      status: "reading",
      stage: null,
      problem: null,
      failures: 0,
      read: { purpose: "baseline", roots: [url], foundBy: "manual", generation: (c.sitemap?.generation ?? 0) + 1, queue: [{ url, depth: 0 }], done: [], lines: 0, chunks: 0, truncated: false, failed: 0, startedAt: now },
    } satisfies Partial<Competitor>);
  }
  if (patch.paused === true && c.status !== "paused") Object.assign(next, { status: "paused", stage: null, read: null });
  if (patch.paused === false && c.status === "paused") {
    Object.assign(next, c.sitemap || c.news ? { status: "watching", stage: null } : { status: "finding", stage: "plain" });
  }
  await repoOf(ctx, deps).competitors.update(id, next);
  return { ok: true, value: { ...c, ...next } };
}

/** Try again from the start of finding (after `needs_you`). What was read before is kept until replaced. */
export async function retryCompetitor(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<Result<Competitor>> {
  const c = await getCompetitor(ctx, id, deps);
  if (!c) return { ok: false, status: 404, error: "not_found" };
  const now = nowOf(deps).toISOString();
  const next: Partial<Competitor> = c.sitemap || c.news
    ? { status: "watching", stage: null, problem: null, failures: 0, nextPostsCheckAt: c.news ? now : null, nextSiteCheckAt: c.sitemap ? now : null, updatedAt: now }
    : // From the start, reading it ourselves first: a site that turned us away may let us in now.
      { status: "finding", stage: "plain", problem: null, failures: 0, reader: "direct", googleFind: null, googlePending: null, updatedAt: now };
  await repoOf(ctx, deps).competitors.update(id, next);
  return { ok: true, value: { ...c, ...next } };
}

/** Check now: the weekly and monthly checks fall due at once (rate limited by the route). */
export async function checkNow(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<Result<Competitor>> {
  const c = await getCompetitor(ctx, id, deps);
  if (!c) return { ok: false, status: 404, error: "not_found" };
  if (c.status !== "watching") return { ok: false, status: 409, error: "not_watching" };
  const now = nowOf(deps).toISOString();
  const next: Partial<Competitor> = { nextPostsCheckAt: c.news ? now : null, nextSiteCheckAt: c.sitemap ? now : null, updatedAt: now };
  await repoOf(ctx, deps).competitors.update(id, next);
  return { ok: true, value: { ...c, ...next } };
}

/** Stop watching: the competitor and everything read about it go. Its brand map name stays. */
export async function removeCompetitor(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<Result<null>> {
  const c = await getCompetitor(ctx, id, deps);
  if (!c) return { ok: false, status: 404, error: "not_found" };
  const repo = repoOf(ctx, deps);
  await repo.competitorPages.deleteWhere([["competitorId", "==", id]]);
  await repo.competitorPosts.deleteWhere([["competitorId", "==", id]]);
  await repo.competitorChanges.deleteWhere([["competitorId", "==", id]]);
  await removeArticles(ctx, id, deps);
  await repo.competitors.delete(id);
  return { ok: true, value: null };
}

/** A page a person typed, as an https address on the competitor's own site (null when it isn't). */
export function pageOnSite(raw: string, site: string): string | null {
  let text = (raw ?? "").trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  text = text.replace(/^http:\/\//i, "https://");
  try {
    const url = assertSafeHttpsUrl(text).toString();
    return onSite(url, site) ? url : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The baseline's pages, by generation
// ---------------------------------------------------------------------------------------------

export async function writeChunks(
  ctx: TenantContext,
  competitorId: string,
  generation: number,
  from: number,
  pages: BaselinePage[],
  deps: StoreDeps = {},
): Promise<number> {
  const repo = repoOf(ctx, deps).competitorPages;
  const chunks = chunkLines(pages.map((p) => line(p.key, p.lastmod)));
  for (const [i, lines] of chunks.entries()) {
    const n = from + i;
    await repo.create(`${competitorId}_g${generation}_${n}`, { competitorId, generation, n, lines });
  }
  return chunks.length;
}

export async function readGeneration(ctx: TenantContext, competitorId: string, generation: number, deps: StoreDeps = {}): Promise<BaselinePage[]> {
  if (!generation) return [];
  const rows = await repoOf(ctx, deps).competitorPages.find({
    where: [
      ["competitorId", "==", competitorId],
      ["generation", "==", generation],
    ],
    limit: 500,
  });
  return pagesFromChunks(rows);
}

/** Drop every chunk of a competitor except one generation's (an abandoned read, or the baseline it replaced). */
export async function dropOtherGenerations(ctx: TenantContext, competitorId: string, keep: number, deps: StoreDeps = {}): Promise<void> {
  const repo = repoOf(ctx, deps).competitorPages;
  const rows = await repo.find({ where: [["competitorId", "==", competitorId]], limit: 1000 });
  for (const r of rows) if (r.generation !== keep) await repo.delete(r.id);
}

export async function dropGeneration(ctx: TenantContext, competitorId: string, generation: number, deps: StoreDeps = {}): Promise<void> {
  await repoOf(ctx, deps).competitorPages.deleteWhere([
    ["competitorId", "==", competitorId],
    ["generation", "==", generation],
  ]);
}

// ---------------------------------------------------------------------------------------------
// Posts seen on the news page
// ---------------------------------------------------------------------------------------------

/** A post's id: scoped by competitor, so two brands watching the same site never share one. */
export function postId(competitorId: string, url: string): string {
  return `${competitorId}_${createHash("sha256").update(normalizeUrl(url) || url).digest("hex").slice(0, 24)}`;
}

export async function listPosts(ctx: TenantContext, competitorId: string, deps: StoreDeps = {}): Promise<CompetitorPost[]> {
  const rows = await repoOf(ctx, deps).competitorPosts.find({ where: [["competitorId", "==", competitorId]], limit: LIMITS.MAX_POSTS + 50 });
  return rows.sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt) || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}

/**
 * Newest first: posts with a date before those without, newest date first; then where they sat on
 * their news page (top first); then the ones we saw most recently.
 */
export function newestFirst(a: Pick<CompetitorPost, "publishedAt" | "rank" | "firstSeenAt">, b: Pick<CompetitorPost, "publishedAt" | "rank" | "firstSeenAt">): number {
  if (Boolean(a.publishedAt) !== Boolean(b.publishedAt)) return a.publishedAt ? -1 : 1;
  const byDate = (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
  if (byDate) return byDate;
  const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
  return ra - rb || b.firstSeenAt.localeCompare(a.firstSeenAt);
}

/**
 * Fill in the date (and place on the page) of stored posts that have none, from their news page's
 * cards. A post that already has a date is left alone. Returns how many were changed.
 */
export async function datePosts(
  ctx: TenantContext,
  competitorId: string,
  cards: Array<{ url: string; publishedAt: string | null; rank: number }>,
  deps: StoreDeps = {},
): Promise<number> {
  const byUrl = new Map(cards.map((c) => [normalizeUrl(c.url) || c.url, c]));
  const repo = repoOf(ctx, deps).competitorPosts;
  const todo = (await listPosts(ctx, competitorId, deps)).filter((p) => !p.publishedAt && byUrl.has(normalizeUrl(p.url) || p.url));
  for (let i = 0; i < todo.length; i += 20) {
    await Promise.all(
      todo.slice(i, i + 20).map((p) => {
        const card = byUrl.get(normalizeUrl(p.url) || p.url)!;
        return repo.update(p.id, { publishedAt: card.publishedAt, rank: card.rank });
      }),
    );
  }
  return todo.length;
}

export async function savePosts(ctx: TenantContext, competitorId: string, posts: Array<Omit<CompetitorPost, "id" | "tenantId" | "competitorId">>, deps: StoreDeps = {}): Promise<void> {
  const repo = repoOf(ctx, deps).competitorPosts;
  for (const p of posts) {
    await repo.upsert(postId(competitorId, p.url), () => ({ competitorId, ...p }), () => null);
  }
  const all = await listPosts(ctx, competitorId, deps);
  for (const old of all.slice(LIMITS.MAX_POSTS)) await repo.delete(old.id);
}

// ---------------------------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------------------------

export async function addChange(ctx: TenantContext, change: Omit<CompetitorChange, "id" | "tenantId">, deps: StoreDeps = {}): Promise<CompetitorChange> {
  const repo = repoOf(ctx, deps).competitorChanges;
  const id = `cc_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const row = await repo.create(id, change);
  const all = await listChanges(ctx, change.competitorId, deps);
  for (const old of all.slice(LIMITS.MAX_CHANGES)) await repo.delete(old.id);
  return row;
}

/** One competitor's changes, newest first. */
export async function listChanges(ctx: TenantContext, competitorId: string, deps: StoreDeps = {}): Promise<CompetitorChange[]> {
  const rows = await repoOf(ctx, deps).competitorChanges.find({ where: [["competitorId", "==", competitorId]], limit: LIMITS.MAX_CHANGES + 20 });
  return rows.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

/** Every change nobody has marked seen, across the brand's competitors, newest first. */
export async function unseenChanges(ctx: TenantContext, deps: StoreDeps = {}): Promise<CompetitorChange[]> {
  const rows = await repoOf(ctx, deps).competitorChanges.find({ where: [["seenAt", "==", null]], limit: LIMITS.MAX_PER_BRAND * LIMITS.MAX_CHANGES });
  return rows.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

/** Mark changes seen: one competitor's (all of them), or the whole brand's. Returns how many. */
export async function markSeen(ctx: TenantContext, competitorId: string | null, deps: StoreDeps = {}): Promise<number> {
  const repo = repoOf(ctx, deps).competitorChanges;
  const rows = await repo.find({
    where: competitorId ? [["seenAt", "==", null], ["competitorId", "==", competitorId]] : [["seenAt", "==", null]],
    limit: LIMITS.MAX_PER_BRAND * LIMITS.MAX_CHANGES,
  });
  const at = nowOf(deps).toISOString();
  for (const r of rows) await repo.update(r.id, { seenAt: at });
  return rows.length;
}
