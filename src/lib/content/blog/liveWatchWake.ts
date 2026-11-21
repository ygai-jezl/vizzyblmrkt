import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { LiveWatchDoc } from "@/lib/types/liveWatch";
import { isBlogLiveWatchEnabled } from "@/lib/brandMap/flags";

/** Found live's record per brand (src/lib/content/blog/liveWatch.ts). Kept apart so a save route can wake it cheaply. */
export const liveWatchDocId = (tenantId: string) => `lw_${tenantId}`;

export function freshLiveWatchDoc(tenantId: string, at: string): LiveWatchDoc {
  return { id: liveWatchDocId(tenantId), tenantId, nextAt: at, sitemapNextAt: null, site: "", sitemaps: [], queue: [], addresses: {}, lastError: null, updatedAt: at };
}

/**
 * Something changed that Found live should look at soon (an address saved, an article written):
 * the brand is due at the next look, within about 10 minutes. Soft: never fails the caller.
 */
export async function wakeLiveWatch(ctx: TenantContext, deps: { db?: FirestoreLike; now?: () => Date } = {}): Promise<void> {
  if (!isBlogLiveWatchEnabled()) return;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  try {
    await forTenant(ctx, deps.db).liveWatch.upsert(
      liveWatchDocId(ctx.tenantId),
      () => {
        const { id: _id, tenantId: _t, ...fields } = freshLiveWatchDoc(ctx.tenantId, at);
        return fields;
      },
      () => ({ nextAt: at }),
    );
  } catch (err) {
    console.warn("[live-watch] wake failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}
