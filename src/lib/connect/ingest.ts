import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ConnectionDiagnostics } from "@/lib/types/productEvent";

/**
 * What the product API's writes share: the Events-tab row TTL, the per-connection
 * diagnostics (observed traits and events, recent rejections) and health.
 */

export interface IngestRejection {
  index: number;
  messageId: string | null;
  reason: string;
}

export interface IngestSummary {
  accepted: number;
  duplicates: number;
  rejected: IngestRejection[];
}

/** Product events are kept this long for the debugger and analytics. */
export const EVENT_TTL_MS = 90 * 24 * 3600_000;
const MAX_OBSERVED = 200;
const MAX_REJECTIONS = 50;
/** Don't rewrite health.lastEventAt more often than this. */
const HEALTH_WRITE_INTERVAL_MS = 60_000;

/** Observed catalog + recent rejections for the setup wizard and debugger. */
export async function recordDiagnostics(
  ctx: TenantContext,
  connection: ProductConnection,
  seen: {
    observedEvents: Map<string, number>;
    observedTraits: Map<string, string>;
    summary: IngestSummary;
    now: string;
  },
  db?: FirestoreLike,
): Promise<void> {
  if (seen.observedEvents.size === 0 && seen.observedTraits.size === 0 && seen.summary.rejected.length === 0) {
    return;
  }
  const merge = (cur: Omit<ConnectionDiagnostics, "id" | "tenantId">) => {
    const events = { ...cur.observedEvents };
    for (const [name, n] of seen.observedEvents) {
      if (!events[name] && Object.keys(events).length >= MAX_OBSERVED) continue;
      events[name] = { count: (events[name]?.count ?? 0) + n, lastAt: seen.now };
    }
    const traits = { ...cur.observedTraits };
    for (const [key, type] of seen.observedTraits) {
      if (!traits[key] && Object.keys(traits).length >= MAX_OBSERVED) continue;
      traits[key] = { type, lastAt: seen.now };
    }
    const rejections = [
      ...seen.summary.rejected.map((r) => ({ at: seen.now, messageId: r.messageId, reason: r.reason })),
      ...cur.recentRejections,
    ].slice(0, MAX_REJECTIONS);
    return { observedEvents: events, observedTraits: traits, recentRejections: rejections, updatedAt: seen.now };
  };
  try {
    await forTenant(ctx, db).connectionDiagnostics.upsert(
      connection.id,
      () => merge({ observedEvents: {}, observedTraits: {}, recentRejections: [], updatedAt: seen.now }),
      (cur) => merge(cur),
    );
  } catch (err) {
    const m = err instanceof Error ? err.message.slice(0, 200) : "error";
    console.warn(`[connect] diagnostics write failed for ${ctx.tenantId}/${connection.id}: ${m}`);
  }
}

/** Stamp health.lastEventAt (throttled — at most once a minute). */
export async function touchHealth(
  ctx: TenantContext,
  connection: ProductConnection,
  summary: IngestSummary,
  nowMs: number,
  db?: FirestoreLike,
): Promise<void> {
  if (summary.accepted + summary.duplicates === 0) return;
  const last = connection.health?.lastEventAt ? Date.parse(connection.health.lastEventAt) : 0;
  if (nowMs - last < HEALTH_WRITE_INTERVAL_MS) return;
  await forTenant(ctx, db)
    .productConnections.update(connection.id, {
      health: { ...connection.health, lastEventAt: new Date(nowMs).toISOString() },
    })
    .catch(() => {});
}
