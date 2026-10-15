import { z } from "zod";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { forTenant, getTenantById } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { indexedSitePages } from "@/lib/knowledge/sitePages";
import { sitesOf, tenantDomains } from "@/lib/knowledge/site";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { isLinkablePage } from "@/lib/content/blog/links";
import { buildPlanPage, buildSitePage, sitePageId } from "@/lib/content/blog/pageRow";
import { syncPlanPage, writePageRow, type PageSync } from "@/lib/content/blog/pageActions";
import { listBrandMapPages } from "./pages";
import { readBrandMap } from "./store";

/**
 * "Read what's already there" (BRAND_MAP_PAGES_ENABLED): rows for the brand's existing blog
 * articles, and for the pages already crawled on its own site, a batch per call. Each call
 * hands back where to carry on; the Brand map page calls again until it is done. Safe to run
 * again: an unchanged row is never rewritten.
 *
 * 1. plans: every blog article in every programme, 25 at a time.
 * 2. rows: every article row, 25 at a time; one whose plan or programme is gone goes.
 * 3. site: the crawled pages on the brand's own sites (its map's site and the domains its
 *    record vouches for), from its most recent programmes; one no longer crawled goes.
 */

export const BackfillCursorSchema = z.strictObject({
  phase: z.enum(["plans", "rows", "site"]),
  ws: z.number().int().min(0).max(10_000).default(0),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  after: z.string().max(200).default(""),
});
export type BackfillCursor = z.infer<typeof BackfillCursorSchema>;

export const BACKFILL_BATCH = 25;
/** A batch per call, with a person waiting on each: generous, but bounded. */
export const BACKFILL_LIMIT = { prefix: "brand_map_pages", burstLimit: 30, hourlyLimit: 600 };
const MAX_SITE_WORKSPACES = 4;
const MAX_SITE_PAGES = 500;

export interface BackfillStep {
  done: boolean;
  next: BackfillCursor | null;
  /** Articles read in this step. */
  articles: number;
  /** Pages on the site read in this step. */
  sitePages: number;
  /** Rows taken off in this step. */
  removed: number;
  /** The brand has no site to read pages of: set one on the map, or a domain in Settings. */
  noSite?: boolean;
}

type Programme = { id: string; archivedAt?: string | null; updatedAt?: string };
type SitePage = { url: string; title: string; links?: string[] | null };

export interface BackfillDeps {
  db?: FirestoreLike;
  workspaces?: (ctx: TenantContext) => Promise<Programme[]>;
  plans?: (ctx: TenantContext, workspaceId: string) => Promise<ContentPlan[]>;
  /** The crawled pages of these programmes. */
  sitePages?: (ctx: TenantContext, workspaceIds: string[]) => Promise<SitePage[]>;
  /** The brand's own sites: its map's site and the domains its record vouches for. */
  ownSites?: (ctx: TenantContext) => Promise<string[]>;
  now?: () => Date;
}

async function eachLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

async function defaultOwnSites(ctx: TenantContext, db?: FirestoreLike): Promise<string[]> {
  const [read, tenant] = await Promise.all([readBrandMap(ctx, db).catch(() => null), getTenantById(ctx.tenantId).catch(() => null)]);
  return [read?.state === "ok" ? read.map.identity.site : "", ...tenantDomains(tenant)].filter(Boolean);
}

async function defaultSitePages(ctx: TenantContext, workspaceIds: string[]): Promise<SitePage[]> {
  const lists = await Promise.all(workspaceIds.map((id) => indexedSitePages(ctx, id).catch(() => ({ pages: [] }))));
  return lists.flatMap((l) => l.pages);
}

const START: BackfillCursor = { phase: "plans", ws: 0, offset: 0, after: "" };

export async function readExistingPages(ctx: TenantContext, cursor: BackfillCursor | null, deps: BackfillDeps = {}): Promise<BackfillStep> {
  const at = cursor ?? START;
  const step: BackfillStep = { done: false, next: null, articles: 0, sitePages: 0, removed: 0 };
  const programmes = await (deps.workspaces ?? ((c: TenantContext) => forTenant(c, deps.db).workspaces.find({ where: [], limit: 200 })))(ctx);

  if (at.phase === "plans") {
    const live = programmes.filter((w) => !w.archivedAt).sort((a, b) => a.id.localeCompare(b.id));
    const w = live[at.ws];
    if (!w) return { ...step, next: { ...START, phase: "rows" } };
    const plans = (await (deps.plans ?? ((c: TenantContext, id: string) => listContentPlans(c, id, 500, deps.db)))(ctx, w.id))
      .filter((p) => buildPlanPage(p) !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    const batch = plans.slice(at.offset, at.offset + BACKFILL_BATCH);
    await eachLimited(batch, 5, (p) => syncPlanPage(ctx, { workspaceId: w.id, planId: p.id, plan: p }, deps));
    const offset = at.offset + batch.length;
    return { ...step, articles: batch.length, next: offset < plans.length ? { ...at, offset } : { ...START, ws: at.ws + 1 } };
  }

  if (at.phase === "rows") {
    const known = new Set(programmes.map((w) => w.id)); // an archived programme's articles stay
    const rows = (await listBrandMapPages(ctx, deps.db))
      .filter((r) => r.kind === "article" && r.id > at.after)
      .sort((a, b) => a.id.localeCompare(b.id));
    const batch = rows.slice(0, BACKFILL_BATCH);
    const results = await eachLimited(batch, 5, async (r): Promise<PageSync> => {
      if (r.workspaceId && r.planId && known.has(r.workspaceId)) return syncPlanPage(ctx, { workspaceId: r.workspaceId, planId: r.planId }, deps);
      await forTenant(ctx, deps.db).brandMapPages.delete(r.id);
      return "removed";
    });
    const removed = results.filter((x) => x === "removed").length;
    const last = batch.at(-1)?.id ?? at.after;
    return { ...step, removed, next: rows.length > batch.length ? { ...at, after: last } : { ...START, phase: "site" } };
  }

  // The pages on the site: one call reads them all (they come from the crawl, not one by one).
  const own = sitesOf(await (deps.ownSites ?? ((c: TenantContext) => defaultOwnSites(c, deps.db)))(ctx));
  if (!own.size) return { ...step, done: true, noSite: true };
  const recent = programmes
    .filter((w) => !w.archivedAt)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, MAX_SITE_WORKSPACES)
    .map((w) => w.id);
  const [listed, rows] = await Promise.all([(deps.sitePages ?? defaultSitePages)(ctx, recent), listBrandMapPages(ctx, deps.db)]);
  // An article written here that the crawl also read is its article row, not a second one.
  const articles = new Set(rows.flatMap((r) => (r.kind === "article" && r.url ? [normalizeUrl(r.url)] : [])));
  const seen = new Set<string>();
  const facts = listed
    .map((p) => buildSitePage(p, own))
    .filter((f): f is NonNullable<typeof f> => {
      if (!f?.url || seen.has(f.url) || articles.has(f.url) || !isLinkablePage(f.url)) return false;
      seen.add(f.url);
      return true;
    })
    .slice(0, MAX_SITE_PAGES);
  const batch = facts.slice(at.offset);
  await eachLimited(batch, 10, (f) => writePageRow(ctx, sitePageId(ctx.tenantId, f.url!), f, deps));
  // All read: a page the crawl no longer has leaves the map.
  const keep = new Set(facts.map((f) => sitePageId(ctx.tenantId, f.url!)));
  const stale = rows.filter((r) => r.kind === "site" && !keep.has(r.id));
  await eachLimited(stale, 10, (r) => forTenant(ctx, deps.db).brandMapPages.delete(r.id).catch(() => undefined));
  return { ...step, done: true, sitePages: batch.length, removed: stale.length };
}
