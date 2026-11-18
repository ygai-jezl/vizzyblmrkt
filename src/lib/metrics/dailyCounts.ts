import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";

/**
 * Daily counts with no person in them, kept forever: widget views (WIDGET_VIEW_COUNTS_ENABLED)
 * and accepted product events (PRODUCT_EVENT_DAYS_ENABLED). Each day is spread over a few shard
 * documents so a busy day never contends on one; readers add the shards up.
 */

export const VIEW_SHARDS = 10;
export const EVENT_SHARDS = 5;
export const EVENT_NAMES_MAX = 200;

export function isWidgetViewCountsEnabled(): boolean {
  return process.env.WIDGET_VIEW_COUNTS_ENABLED === "true";
}

export function isProductEventDaysEnabled(): boolean {
  return process.env.PRODUCT_EVENT_DAYS_ENABLED === "true";
}

const dayOf = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);

/** Count one widget view for a launch, today. */
export async function countWidgetView(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  campaignId: string,
  deps: { db?: FirestoreLike; nowMs?: number; shard?: number } = {},
): Promise<void> {
  const nowMs = deps.nowMs ?? Date.now();
  const day = dayOf(nowMs);
  const shard = deps.shard ?? Math.floor(Math.random() * VIEW_SHARDS);
  const id = `wvd:${safe(campaignId)}:${day}:${shard}`;
  const at = new Date(nowMs).toISOString();
  await forTenant({ ...ctx, source: "system" }, deps.db).widgetViewDays.upsert(
    id,
    () => ({ campaignId, day, shard, views: 1, updatedAt: at }) as never,
    (cur) => ({ views: (cur.views ?? 0) + 1, updatedAt: at }) as never,
  );
}

/** Add one ingest batch's accepted events (name to count) to a connection's day. */
export async function countProductEvents(
  ctx: Pick<TenantContext, "tenantId" | "region">,
  connectionId: string,
  counts: Record<string, number>,
  deps: { db?: FirestoreLike; nowMs?: number; shard?: number } = {},
): Promise<void> {
  const names = Object.entries(counts).filter(([, n]) => n > 0);
  if (!names.length) return;
  const nowMs = deps.nowMs ?? Date.now();
  const day = dayOf(nowMs);
  const shard = deps.shard ?? Math.floor(Math.random() * EVENT_SHARDS);
  const id = `ped:${safe(connectionId)}:${day}:${shard}`;
  const at = new Date(nowMs).toISOString();
  const add = (base: Record<string, number>) => {
    const out = { ...base };
    for (const [name, n] of names) {
      const key = name in out || Object.keys(out).length < EVENT_NAMES_MAX ? name : "other";
      out[key] = (out[key] ?? 0) + n;
    }
    return out;
  };
  await forTenant({ ...ctx, source: "system" }, deps.db).productEventDays.upsert(
    id,
    () => ({ connectionId, day, shard, counts: add({}), updatedAt: at }) as never,
    (cur) => ({ counts: add(cur.counts ?? {}), updatedAt: at }) as never,
  );
}
