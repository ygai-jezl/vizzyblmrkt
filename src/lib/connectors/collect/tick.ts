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
import { expireConnectorSignals, reconcileProposals } from "../signals/reconcile";
import { partHousekeeping, sweepOrganisationConnections } from "../organisation";
import { PartCache, partLive, readableOnly } from "../sources";
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
 *   erase a connection still has pending (its article step stopping at the lane's deadline, what is
 *   left staying pending for the next run), and, for a brand with Search Console, declining its
 *   suggestions from collected numbers that are past their 30 days and putting the questions they
 *   proposed on the brand map in step (src/lib/connectors/signals/reconcile.ts);
 * - collecting, only with CONNECTORS_COLLECT_ENABLED: each due connection, one at a time, under its
 *   lease, with no new day started under 10 seconds before the budget ends;
 * - suggestions, only with CONNECTOR_SIGNALS_ENABLED: each Search Console connection that feeds
 *   planning and rolled a new day today, looked at once that day (src/lib/connectors/signals/detect.ts),
 *   with no look started under 12 seconds before the budget ends.
 * Each run logs how far behind it is: the oldest nextAt among the due connections it saw.
 *
 * Shared connections (Connectors 3, ADR-0015), whenever CONNECTORS_ENABLED is on, whatever sharing
 * or plans say: first a sweep of every region's connected organisation connections (those of an
 * organisation gone or with no brands are disconnected; half done gives, changes and take backs are
 * repaired on positive evidence), then for each brand its parts' housekeeping (a part ends only on
 * positive evidence; a disconnected part's stale entry is dropped). A brand's part is collected and
 * looked at for suggestions only while partLive honours it and its organisation's connection isn't
 * holding collection; otherwise it is skipped quietly, with no failure, so Review never asks a brand
 * admin to reconnect it. The reads behind partLive are kept for the run, for those read only checks;
 * housekeeping never ends a part on them (it reads afresh first). A suggestion reads another
 * connection's numbers (Google Analytics sessions beside Search Console's) only from one every way
 * out may read now: a brand's own, or a part partLive honours. A suspended brand gets its parts'
 * housekeeping and its pending erases only (nothing collected, nothing looked at), so a part its
 * organisation ended is still ended and erased, and an erase that failed, on any of its records,
 * disconnected ones included, is tried again on the next run.
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
  housekeeping?: (
    ctx: TenantContext,
    connections: DataConnection[],
    deps: { db?: LaneDeps["db"]; now?: Date; searchIndex?: SearchIndexOf; regionDb?: LaneDeps["regionDb"]; controlDb?: LaneDeps["controlDb"]; partCache?: PartCache; deadlineMs?: number },
  ) => Promise<{ erased: number; expired?: number; partsEnded?: number }>;
  /** The sweep of organisation connections (tests stub it). */
  sweep?: typeof sweepOrganisationConnections;
  /** Look at one connection for suggestions (tests stub it). */
  detect?: (ctx: TenantContext, conn: DataConnection, others: readonly DataConnection[], deps: { db?: LaneDeps["db"]; now?: Date }) => Promise<DetectResult>;
  /** The brand's search index for erases (tests pass an in-memory one). */
  searchIndex?: SearchIndexOf;
  log?: (line: string) => void;
}

export interface LaneResult {
  /** Brands looked at. */
  brands: number;
  /** Organisation connections disconnected by the sweep, and parts it repaired. */
  swept?: number;
  repaired?: number;
  /** Parts ended by housekeeping on positive evidence. */
  partsEnded?: number;
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
  const all = await (deps.listTenants ?? listAllTenants)();
  const tenants = all.filter((t) => t.status !== "suspended");
  const suspended = all.filter((t) => t.status === "suspended");
  const offset = tenants.length ? Math.floor(clock() / (LANE.TICK_MS * LANE.EVERY)) % tenants.length : 0;
  const order = [...tenants.slice(offset), ...tenants.slice(0, offset)];
  let oldestDue: number | null = null;
  // One cache of the reads behind partLive for the whole run.
  const partCache = new PartCache();
  // An erase's article step stops on the real clock: the lane's deadline, as the time left from now.
  const eraseBy = () => Date.now() + (opts.deadlineMs - clock());
  try {
    const swept = await (deps.sweep ?? sweepOrganisationConnections)({ deadlineMs: opts.deadlineMs, clock, minLeftMs: MIN_START_MS }, { ...deps, now: new Date(clock()) });
    result.swept = swept.disconnected;
    result.repaired = swept.repaired;
  } catch (err) {
    console.warn("[connectors] the organisation connections sweep failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  // Suspended brands: their parts' housekeeping, on positive evidence, and any erase still pending on
  // any of their records, disconnected ones included. Nothing collected, nothing looked at.
  for (const t of suspended) {
    if (opts.deadlineMs - clock() < MIN_START_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const db = deps.regionDb?.(t.region) ?? deps.db;
    try {
      const records = await forTenant(ctx, db).dataConnections.find({ limit: LANE.CONNECTIONS_PER_BRAND });
      const parts = records.filter((c) => c.source && c.status === "connected");
      if (parts.length) {
        const ended = await partHousekeeping(ctx, parts, { db, now: new Date(clock()), searchIndex: deps.searchIndex, regionDb: deps.regionDb, controlDb: deps.controlDb, partCache, deadlineMs: eraseBy() });
        result.partsEnded = (result.partsEnded ?? 0) + ended.ended;
      }
      // A part ended just now was erased as it ended; one whose erase failed on an earlier run is tried again here.
      const { erased } = await retryPendingErases(ctx, records, { db, now: new Date(clock()), searchIndex: deps.searchIndex, deadlineMs: eraseBy() });
      result.erased += erased;
    } catch (err) {
      console.warn(`[connectors] part housekeeping for suspended ${t.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  for (const t of order) {
    if (opts.deadlineMs - clock() < MIN_START_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    // The brand's own region's database (tests pass one per region; production reads the region's own).
    const brand: LaneDeps = { ...deps, db: deps.regionDb?.(t.region) ?? deps.db };
    try {
      const conns = await forTenant(ctx, brand.db).dataConnections.find({ limit: LANE.CONNECTIONS_PER_BRAND });
      result.brands += 1;
      const kept = await (deps.housekeeping ?? laneHousekeeping)(ctx, conns, {
        db: brand.db,
        now: new Date(clock()),
        searchIndex: deps.searchIndex,
        regionDb: deps.regionDb,
        controlDb: deps.controlDb,
        partCache,
        deadlineMs: eraseBy(),
      });
      result.erased += kept.erased;
      result.expired += kept.expired ?? 0;
      result.partsEnded = (result.partsEnded ?? 0) + (kept.partsEnded ?? 0);
      if (!collecting) continue;
      const now = new Date(clock());
      for (const c of conns) {
        if (!isDue(c, now)) continue;
        // A part's collect reads its source afresh: a hold another part set this run must stop it.
        if (c.source && !(await collectablePart(ctx, c, now, { ...brand, partCache }))) continue;
        const nextAt = collectOf(c).nextAt;
        const dueAt = nextAt ? Date.parse(nextAt) : now.getTime();
        if (oldestDue === null || dueAt < oldestDue) oldestDue = dueAt;
        if (opts.deadlineMs - clock() < MIN_START_MS) break;
        const r: CollectRunResult = await (deps.collect ?? collectConnection)(ctx, c.id, { deadlineMs: opts.deadlineMs }, { ...brand, clock });
        if (r.status === "collected" || r.status === "nothing") result.connections += 1;
        if (r.status === "failed") result.failed += 1;
        result.days += r.days;
      }
      if (suggesting) result.detected += await detectBrand(ctx, conns, opts.deadlineMs, { ...brand, clock, partCache });
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
 * pending, then, where the brand has Search Console, its suggestions past their 30 days, its brand
 * map proposals in step with their questions (withdrawn ones count as expired), and whatever a
 * connection that no longer feeds planning (members or Vizzy lost the grant) still has open:
 * declined, and its undecided proposals withdrawn.
 */
export async function laneHousekeeping(
  ctx: TenantContext,
  connections: DataConnection[],
  deps: { db?: LaneDeps["db"]; now?: Date; searchIndex?: SearchIndexOf; regionDb?: LaneDeps["regionDb"]; controlDb?: LaneDeps["controlDb"]; partCache?: PartCache; deadlineMs?: number } = {},
): Promise<{ erased: number; expired: number; partsEnded: number }> {
  // Parts first, whatever sharing or plans say: one ended now is erased here, and a stale entry dropped.
  let partsEnded = 0;
  try {
    partsEnded = (await partHousekeeping(ctx, connections, deps)).ended;
  } catch (err) {
    console.warn(`[connectors] part housekeeping for ${ctx.tenantId} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  const { erased } = await retryPendingErases(ctx, connections, deps);
  let expired = 0;
  const searchConsole = connections.filter((c) => c.connectorId === searchConsoleManifest.id);
  if (searchConsole.length) {
    const notPlanning = new Set(searchConsole.filter((c) => c.status === "connected" && !feedsPlanning(c.grants)).map((c) => c.id));
    try {
      expired = (await expireConnectorSignals(ctx, { db: deps.db, now: deps.now, notPlanning })).expired;
      const r = await reconcileProposals(ctx, searchConsole.map((c) => c.id), { db: deps.db, now: deps.now, notPlanning });
      expired += r.withdrawn;
    } catch (err) {
      console.warn(`[connectors] expiring suggestions for ${ctx.tenantId} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return { erased, expired, partsEnded };
}

/**
 * Whether the lane collects a brand's part now: partLive honours it and its organisation's
 * connection isn't holding collection for every part. Otherwise it is skipped quietly: no lease, no
 * failure, nothing on its health.
 */
async function collectablePart(ctx: TenantContext, c: DataConnection, now: Date, deps: LaneDeps & { partCache: PartCache }): Promise<boolean> {
  const check = await partLive(ctx, c, deps);
  if (!check.live) return false;
  const hold = check.source.collectHold;
  return !(hold && Date.parse(hold.until) > now.getTime());
}

/** A Search Console connection to look at for suggestions now: feeds planning, rolled today, not looked at today. */
export function isDetectDue(c: DataConnection, today: string): boolean {
  const k = c.collect;
  return c.connectorId === searchConsoleManifest.id && c.status === "connected" && feedsPlanning(c.grants) && !!k?.lastDay && k.rolledOn === today && k.detectedOn !== today;
}

/**
 * Look at a brand's due Search Console connections for suggestions, freshly read. Returns how many.
 * The other connections a look reads beside it (Google Analytics sessions) are read afresh, once,
 * and only those every way out may read now: a brand's own, or a part partLive honours with fresh
 * reads, so a part that reads nothing never puts its numbers in a Search Console suggestion.
 */
async function detectBrand(ctx: TenantContext, conns: DataConnection[], deadlineMs: number, deps: LaneDeps & { clock: () => number; partCache: PartCache }): Promise<number> {
  let n = 0;
  let others: DataConnection[] | null = null;
  const othersNow = async () => {
    if (!others) {
      const connected = await forTenant(ctx, deps.db).dataConnections.find({ where: [["status", "==", "connected"]], limit: LANE.CONNECTIONS_PER_BRAND });
      others = await readableOnly(ctx, connected, { ...deps, partCache: new PartCache() });
    }
    return others;
  };
  for (const c of conns) {
    if (c.connectorId !== searchConsoleManifest.id || c.status !== "connected") continue;
    if (deadlineMs - deps.clock() < LANE.DETECT_MIN_MS) break;
    const now = new Date(deps.clock());
    const fresh = await forTenant(ctx, deps.db).dataConnections.getById(c.id);
    if (!fresh || !isDetectDue(fresh, todayIn(now, "UTC"))) continue;
    // A brand's part is looked at only while its organisation still gives it.
    if (fresh.source && !(await partLive(ctx, fresh, deps)).live) continue;
    try {
      const r = await (deps.detect ?? detectConnection)(ctx, fresh, await othersNow(), { db: deps.db, now });
      if (r.status === "detected") n += 1;
    } catch (err) {
      console.warn(`[connectors] looking at ${c.id} for suggestions failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return n;
}
