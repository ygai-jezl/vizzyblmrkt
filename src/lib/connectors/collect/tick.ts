import { forTenant } from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { TenantContext } from "@/lib/tenant/types";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { Tenant } from "@/lib/types/tenant";
import { retryPendingErases, type SearchIndexOf } from "../erase";
import { isConnectorsCollectEnabled, isConnectorSignalsEnabled, isConnectorsEnabled } from "../flags";
import { feedsPlanning } from "../grants";
import { searchConsoleManifest } from "../manifests/searchConsole";
import { todayIn } from "../period";
import { detectConnection, type DetectResult } from "../signals/detect";
import { expireConnectorSignals } from "../signals/reconcile";
import { collectConnection, collectOf, isDue, MIN_START_MS, type CollectRunDeps, type CollectRunResult } from "./run";

/**
 * The connectors lane of the lifecycle tick (Connectors 2, ADR-0012). The tick runs every 2
 * minutes; this lane runs on every 15th, at offset 7, so it never shares a tick with the
 * competitor scan, the search sweep or Found live (multiples of 5 and 15), and has its own 25
 * second budget beside the lanes that run on every tick.
 *
 * Brands take turns from a rotating offset, one data_connections query each (equality on the
 * brand only), suspended brands skipped. For each brand:
 * - housekeeping, whenever CONNECTORS_ENABLED is on, whatever collect or signals say: retrying an
 *   erase a connection still has pending, and, for a brand with Search Console, declining its
 *   suggestions from collected numbers that are past their 30 days;
 * - collecting, only with CONNECTORS_COLLECT_ENABLED: each due connection, one at a time, under its
 *   lease, with no new day started under 10 seconds before the budget ends;
 * - suggestions, only with CONNECTOR_SIGNALS_ENABLED: each Search Console connection that feeds
 *   planning and rolled a new day today, looked at once that day (src/lib/connectors/signals/detect.ts),
 *   with no look started under 12 seconds before the budget ends.
 * Each run logs how far behind it is: the oldest nextAt among the due connections it saw.
 */

export const LANE = {
  TICK_MS: 120_000,
  /** Every 15th tick: about every 30 minutes. */
  EVERY: 15,
  OFFSET: 7,
  /** Connections read for one brand. */
  CONNECTIONS_PER_BRAND: 200,
  /** No look for suggestions starts with less than this left. */
  DETECT_MIN_MS: 12_000,
} as const;

/** A tick the lane runs on: Math.floor(now / 120_000) % 15 === 7. */
export const isLaneTick = (nowMs: number) => Math.floor(nowMs / LANE.TICK_MS) % LANE.EVERY === LANE.OFFSET;

export interface LaneDeps extends CollectRunDeps {
  listTenants?: () => Promise<Tenant[]>;
  /** Collect one connection (tests stub it). */
  collect?: typeof collectConnection;
  /** The housekeeping for one brand's connections (erase retries), run whatever collect says. */
  housekeeping?: (ctx: TenantContext, connections: DataConnection[], deps: { db?: LaneDeps["db"]; now?: Date; searchIndex?: SearchIndexOf }) => Promise<{ erased: number; expired?: number }>;
  /** Look at one connection for suggestions (tests stub it). */
  detect?: (ctx: TenantContext, conn: DataConnection, others: readonly DataConnection[], deps: { db?: LaneDeps["db"]; now?: Date }) => Promise<DetectResult>;
  /** The brand's search index for erases (tests pass an in-memory one). */
  searchIndex?: SearchIndexOf;
  log?: (line: string) => void;
}

export interface LaneResult {
  /** Brands looked at. */
  brands: number;
  /** Connections collected (a run that landed days or found none new). */
  connections: number;
  days: number;
  failed: number;
  erased: number;
  /** Suggestions declined at their expiry, and connections looked at for new ones. */
  expired: number;
  detected: number;
  /** Minutes since the oldest due nextAt it saw, or null when nothing was due. */
  behindMin: number | null;
}

export async function runConnectorsLane(opts: { deadlineMs: number }, deps: LaneDeps = {}): Promise<LaneResult> {
  const result: LaneResult = { brands: 0, connections: 0, days: 0, failed: 0, erased: 0, expired: 0, detected: 0, behindMin: null };
  if (!isConnectorsEnabled()) return result;
  const clock = deps.clock ?? Date.now;
  if (!isLaneTick(clock())) return result;
  const collecting = isConnectorsCollectEnabled();
  const suggesting = isConnectorSignalsEnabled();
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => t.status !== "suspended");
  const offset = tenants.length ? Math.floor(clock() / (LANE.TICK_MS * LANE.EVERY)) % tenants.length : 0;
  const order = [...tenants.slice(offset), ...tenants.slice(0, offset)];
  let oldestDue: number | null = null;
  for (const t of order) {
    if (opts.deadlineMs - clock() < MIN_START_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const conns = await forTenant(ctx, deps.db).dataConnections.find({ limit: LANE.CONNECTIONS_PER_BRAND });
      result.brands += 1;
      const kept = await (deps.housekeeping ?? laneHousekeeping)(ctx, conns, { db: deps.db, now: new Date(clock()), searchIndex: deps.searchIndex });
      result.erased += kept.erased;
      result.expired += kept.expired ?? 0;
      if (!collecting) continue;
      const now = new Date(clock());
      for (const c of conns) {
        if (!isDue(c, now)) continue;
        const nextAt = collectOf(c).nextAt;
        const dueAt = nextAt ? Date.parse(nextAt) : now.getTime();
        if (oldestDue === null || dueAt < oldestDue) oldestDue = dueAt;
        if (opts.deadlineMs - clock() < MIN_START_MS) break;
        const r: CollectRunResult = await (deps.collect ?? collectConnection)(ctx, c.id, { deadlineMs: opts.deadlineMs }, { ...deps, clock });
        if (r.status === "collected" || r.status === "nothing") result.connections += 1;
        if (r.status === "failed") result.failed += 1;
        result.days += r.days;
      }
      if (suggesting) result.detected += await detectBrand(ctx, conns, opts.deadlineMs, { ...deps, clock });
    } catch (err) {
      result.failed += 1;
      console.warn(`[connectors] lane failed for ${t.id}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  if (oldestDue !== null) result.behindMin = Math.max(0, Math.round((clock() - oldestDue) / 60_000));
  (deps.log ?? ((line: string) => console.info(line)))(
    `[connectors] lane: ${result.brands} of ${tenants.length} brands, ${result.connections} collected, ${result.days} days, ${result.failed} failed, ${result.erased} erased, ${result.expired} suggestions expired, ${result.detected} looked at for suggestions; oldest due ${result.behindMin === null ? "none" : `${result.behindMin} min ago`}`,
  );
  return result;
}

/**
 * The housekeeping the lane runs for every brand whatever collect or signals say: erases still
 * pending, then, where the brand has Search Console, its suggestions past their 30 days.
 */
export async function laneHousekeeping(
  ctx: TenantContext,
  connections: DataConnection[],
  deps: { db?: LaneDeps["db"]; now?: Date; searchIndex?: SearchIndexOf } = {},
): Promise<{ erased: number; expired: number }> {
  const { erased } = await retryPendingErases(ctx, connections, deps);
  let expired = 0;
  if (connections.some((c) => c.connectorId === searchConsoleManifest.id)) {
    try {
      expired = (await expireConnectorSignals(ctx, { db: deps.db, now: deps.now })).expired;
    } catch (err) {
      console.warn(`[connectors] expiring suggestions for ${ctx.tenantId} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return { erased, expired };
}

/** A Search Console connection to look at for suggestions now: feeds planning, rolled today, not looked at today. */
export function isDetectDue(c: DataConnection, today: string): boolean {
  const k = c.collect;
  return c.connectorId === searchConsoleManifest.id && c.status === "connected" && feedsPlanning(c.grants) && !!k?.lastDay && k.rolledOn === today && k.detectedOn !== today;
}

/** Look at a brand's due Search Console connections for suggestions, freshly read. Returns how many. */
async function detectBrand(ctx: TenantContext, conns: DataConnection[], deadlineMs: number, deps: LaneDeps & { clock: () => number }): Promise<number> {
  let n = 0;
  for (const c of conns) {
    if (c.connectorId !== searchConsoleManifest.id || c.status !== "connected") continue;
    if (deadlineMs - deps.clock() < LANE.DETECT_MIN_MS) break;
    const now = new Date(deps.clock());
    const fresh = await forTenant(ctx, deps.db).dataConnections.getById(c.id);
    if (!fresh || !isDetectDue(fresh, todayIn(now, "UTC"))) continue;
    try {
      const r = await (deps.detect ?? detectConnection)(ctx, fresh, conns, { db: deps.db, now });
      if (r.status === "detected") n += 1;
    } catch (err) {
      console.warn(`[connectors] looking at ${c.id} for suggestions failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return n;
}
