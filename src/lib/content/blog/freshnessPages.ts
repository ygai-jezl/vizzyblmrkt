import { isBlogFreshnessEnabled } from "@/lib/brandMap/flags";
import { pageKey } from "@/lib/connectors/keys";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";

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

/** The brand's live article at a Search Console page, from the freshness watch, or null. */
export async function liveArticleAt(ctx: TenantContext, key: string, deps: { db?: FirestoreLike } = {}): Promise<{ planId: string; workspaceId: string } | null> {
  if (!isBlogFreshnessEnabled()) return null;
  const watch = await forTenant(ctx, deps.db).freshnessWatch.getById(freshnessWatchId(ctx.tenantId)).catch(() => null);
  const hit = watch?.pages.find((p) => p.key === key);
  return hit ? { planId: hit.planId, workspaceId: hit.workspaceId } : null;
}

export { refreshHref } from "./freshnessHref";
