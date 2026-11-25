import { isBlogFreshnessEnabled } from "@/lib/brandMap/flags";
import { pageKey } from "@/lib/connectors/keys";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { listRecentContentPlans } from "@/lib/tenant/workspaceContent";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { FreshnessDueItem, FreshnessWatchDoc } from "@/lib/types/freshness";

/**
 * Article freshness's link between Search Console's pages and the brand's live articles
 * (BLOG_FRESHNESS_ENABLED): both keyed as Search Console keys a page, host and path.
 */

export const freshnessWatchId = (tenantId: string) => `fw_${tenantId}`;

/** A Search Console host or a site address as a bare host: no scheme, "sc-domain:", "www." or path. */
export function bareHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

/** An article's live address as Search Console keys pages, or null when it isn't an address. */
export function articlePageKey(url: string): string | null {
  try {
    const u = new URL(url);
    return pageKey(bareHost(u.hostname), u.pathname);
  } catch {
    return null;
  }
}

/** A Search Console page row's key: its own host (else the property's), and its path. */
export function signalPageKey(host: string | undefined, account: string, path: string): string {
  return pageKey(bareHost(host ?? account), path);
}

/** The brand's freshness watch record, or null while freshness is off or the watch hasn't looked yet. */
export async function readFreshnessWatch(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<FreshnessWatchDoc | null> {
  if (!isBlogFreshnessEnabled()) return null;
  return forTenant(ctx, deps.db).freshnessWatch.getById(freshnessWatchId(ctx.tenantId)).catch(() => null);
}

/** The brand's live articles due, or soon due, a refresh (due first), from the freshness watch. */
export async function readDueArticles(ctx: TenantContext, deps: { db?: FirestoreLike } = {}): Promise<FreshnessDueItem[]> {
  return (await readFreshnessWatch(ctx, deps))?.due ?? [];
}

/** The brand's live article at a Search Console page, from the freshness watch, or null. */
export async function liveArticleAt(ctx: TenantContext, key: string, deps: { db?: FirestoreLike } = {}): Promise<{ planId: string; workspaceId: string } | null> {
  const watch = await readFreshnessWatch(ctx, deps);
  const hit = watch?.pages.find((p) => p.key === key);
  return hit ? { planId: hit.planId, workspaceId: hit.workspaceId } : null;
}

/** How far the watch looks for a brand's live articles: its first programmes, and each one's newest plans. */
export const LIVE_ARTICLES = { MAX_PROGRAMMES: 20, PLANS_PER_PROGRAMME: 100 } as const;

export interface LiveArticle {
  plan: ContentPlan;
  hub: ContentNode;
  url: string;
  key: string | null;
}

/**
 * The brand's live blog articles, as the freshness watch looks at them: a blog hub with its live
 * mark and a published date, in a plan that isn't archived, within LIVE_ARTICLES.
 */
export async function liveArticles(ctx: TenantContext, db?: FirestoreLike): Promise<LiveArticle[]> {
  const out: LiveArticle[] = [];
  const programmes = (await forTenant(ctx, db).workspaces.find({ where: [], limit: 200 })).filter((w) => !w.archivedAt).slice(0, LIVE_ARTICLES.MAX_PROGRAMMES);
  for (const ws of programmes) {
    const plans = await listRecentContentPlans(ctx, ws.id, LIVE_ARTICLES.PLANS_PER_PROGRAMME, db).catch(() => [] as ContentPlan[]);
    for (const plan of plans) {
      if (plan.status === "archived" || plan.topology.hubChannel !== "blog") continue;
      const hub = plan.graph.nodes.find((n) => n.type === "hub" && n.channel === "blog");
      const live = hub?.blog?.live;
      if (!hub || !live || !hub.blog?.dates?.published) continue;
      out.push({ plan, hub, url: live.url, key: articlePageKey(live.url) });
    }
  }
  return out;
}

export { refreshHref } from "./freshnessHref";
