import { z } from "zod";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ContentPlan } from "@/lib/types/contentPlan";
import type { BrandMapPage, BrandMapPageFacts } from "@/lib/types/brandMapPage";
import { forTenant, getTenantById, listKnowledgePages } from "@/lib/tenant";
import { listContentPlans } from "@/lib/tenant/workspaceContent";
import { sourcesToList } from "@/lib/knowledge/sitePages";
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
 * 1. plans: every blog article in every programme, 25 at a time, each read fresh.
 * 2. rows: every article row, 25 at a time; one whose plan or programme is gone goes.
 * 3. site: the crawled pages on the brand's own sites (its map's site and the domains its
 *    record vouches for), from its most recent programmes. A page row goes only when this read
 *    can vouch for it: its source was read again without it, its source was removed, or it is
 *    now an article written here. A source that could not be read, or was not read this time,
 *    takes nothing away.
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
/** Programmes and sources listed at a time; a list this long may be missing some. */
const LISTED = 200;

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

/** One source's crawled pages, read in full. */
export interface ListedSource {
  workspaceId: string;
  ticketId: string;
  pages: SitePage[];
}

/** What the site phase read: the sources it could read, and each programme's sources when listed in full. */
export interface SiteListing {
  sources: ListedSource[];
  tickets: Map<string, Set<string>>;
}

export interface BackfillDeps {
  db?: FirestoreLike;
  workspaces?: (ctx: TenantContext) => Promise<Programme[]>;
  plans?: (ctx: TenantContext, workspaceId: string) => Promise<ContentPlan[]>;
  /** The crawled pages of these programmes, source by source. */
  siteListing?: (ctx: TenantContext, workspaceIds: string[]) => Promise<SiteListing>;
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

/** The crawled pages of each programme, source by source, from the page records when there are some. */
async function defaultSiteListing(ctx: TenantContext, workspaceIds: string[], db?: FirestoreLike): Promise<SiteListing> {
  const out: SiteListing = { sources: [], tickets: new Map() };
  await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      let tickets;
      try {
        tickets = await forTenant(ctx, db).ingestionTickets.find({
          where: [
            ["ownerKind", "==", "workspace"],
            ["ownerId", "==", workspaceId],
          ],
          limit: LISTED,
        });
      } catch {
        return; // this programme was not read: nothing of it is taken away
      }
      if (tickets.length < LISTED) out.tickets.set(workspaceId, new Set(tickets.map((t) => t.id)));
      // The brand's own crawled sites (a repo's files are not pages).
      const web = sourcesToList(tickets).own.filter((t) => t.source !== "github" && t.source !== "gitlab");
      await Promise.all(
        web.map(async (t) => {
          try {
            const pages = await listKnowledgePages(ctx, "workspace", workspaceId, { ticketId: t.id, limit: 600, records: true });
            out.sources.push({ workspaceId, ticketId: t.id, pages: pages.map((p) => ({ url: p.sourceUri, title: p.title, links: p.links ?? null })) });
          } catch {
            // Not read: nothing of it is taken away.
          }
        }),
      );
    }),
  );
  out.sources.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.ticketId.localeCompare(b.ticketId));
  return out;
}

const START: BackfillCursor = { phase: "plans", ws: 0, offset: 0, after: "" };

/** Site rows this read can vouch are gone. */
function staleSiteRows(rows: BrandMapPage[], listing: SiteListing, articles: Set<string>): BrandMapPage[] {
  const read = new Map(listing.sources.map((s) => [s.ticketId, new Set(s.pages.map((p) => normalizeUrl(p.url)))]));
  return rows.filter((r) => {
    if (r.kind !== "site" || !r.url) return false;
    const url = normalizeUrl(r.url);
    if (articles.has(url)) return true; // now an article written here
    if (!r.sourceId || !r.workspaceId) return false; // where it came from is not known
    const tickets = listing.tickets.get(r.workspaceId);
    if (tickets && !tickets.has(r.sourceId)) return true; // its source was removed
    const urls = read.get(r.sourceId);
    return Boolean(urls) && !urls!.has(url); // its source was read again without it
  });
}

export async function readExistingPages(ctx: TenantContext, cursor: BackfillCursor | null, deps: BackfillDeps = {}): Promise<BackfillStep> {
  const at = cursor ?? START;
  const step: BackfillStep = { done: false, next: null, articles: 0, sitePages: 0, removed: 0 };
  const programmes = await (deps.workspaces ?? ((c: TenantContext) => forTenant(c, deps.db).workspaces.find({ where: [], limit: LISTED })))(ctx);

  if (at.phase === "plans") {
    const live = programmes.filter((w) => !w.archivedAt).sort((a, b) => a.id.localeCompare(b.id));
    const w = live[at.ws];
    if (!w) return { ...step, next: { ...START, phase: "rows" } };
    const plans = (await (deps.plans ?? ((c: TenantContext, id: string) => listContentPlans(c, id, 500, deps.db)))(ctx, w.id))
      .filter((p) => buildPlanPage(p) !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    const batch = plans.slice(at.offset, at.offset + BACKFILL_BATCH);
    // Each read fresh as its row is written, so a save made meanwhile is never undone.
    await eachLimited(batch, 5, (p) => syncPlanPage(ctx, { workspaceId: w.id, planId: p.id }, deps));
    const offset = at.offset + batch.length;
    return { ...step, articles: batch.length, next: offset < plans.length ? { ...at, offset } : { ...START, ws: at.ws + 1 } };
  }

  if (at.phase === "rows") {
    const known = new Set(programmes.map((w) => w.id)); // an archived programme's articles stay
    const exists = async (id: string): Promise<boolean> => {
      if (known.has(id)) return true;
      if (programmes.length < LISTED) return false; // the list was complete
      try {
        return Boolean(await forTenant(ctx, deps.db).workspaces.getById(id));
      } catch {
        return true; // not sure: keep it
      }
    };
    const rows = (await listBrandMapPages(ctx, deps.db))
      .filter((r) => r.kind === "article" && r.id > at.after)
      .sort((a, b) => a.id.localeCompare(b.id));
    const batch = rows.slice(0, BACKFILL_BATCH);
    const results = await eachLimited(batch, 5, async (r): Promise<PageSync> => {
      if (r.workspaceId && r.planId && (await exists(r.workspaceId))) return syncPlanPage(ctx, { workspaceId: r.workspaceId, planId: r.planId }, deps);
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
  const [listing, rows] = await Promise.all([
    (deps.siteListing ?? ((c: TenantContext, ids: string[]) => defaultSiteListing(c, ids, deps.db)))(ctx, recent),
    listBrandMapPages(ctx, deps.db),
  ]);
  // An article written here that the crawl also read is its article row, not a second one.
  const articles = new Set(rows.flatMap((r) => (r.kind === "article" && r.url ? [normalizeUrl(r.url)] : [])));
  const seen = new Set<string>();
  const facts: BrandMapPageFacts[] = [];
  for (const source of listing.sources) {
    for (const p of source.pages) {
      const f = buildSitePage(p, own, { workspaceId: source.workspaceId, sourceId: source.ticketId });
      if (!f?.url || seen.has(f.url) || articles.has(f.url) || !isLinkablePage(f.url)) continue;
      seen.add(f.url);
      facts.push(f);
    }
  }
  const batch = facts.slice(at.offset, MAX_SITE_PAGES);
  await eachLimited(batch, 10, (f) => writePageRow(ctx, sitePageId(ctx.tenantId, f.url!), f, deps));
  const stale = staleSiteRows(rows, listing, articles);
  await eachLimited(stale, 10, (r) => forTenant(ctx, deps.db).brandMapPages.delete(r.id).catch(() => undefined));
  return { ...step, done: true, sitePages: batch.length, removed: stale.length };
}
