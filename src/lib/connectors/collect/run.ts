import { randomBytes } from "node:crypto";
import { changeDataConnection, type ActivityWrite, type DataConnectionPatch, type TenantContext } from "@/lib/tenant";
import { CollectStateSchema, type CollectState, type DataConnection } from "@/lib/types/dataConnection";
import { pendingWith } from "../erase";
import { COLLECT_HOOKS } from "../handlers";
import type { CollectResult, HookFailure } from "../handlers/types";
import { countsAsFailure, isCallPaused } from "../health";
import { collectedStream, type ConnectorManifest } from "../manifest";
import { todayIn } from "../period";
import { getConnector, knownConnector } from "../registry";
import { codeFor, connectionToken, outcomePlan, SYSTEM, type ServiceDeps } from "../service";
import { rollConnection } from "../rollups";
import { dropAgedDay, writeDayDoc } from "../snapshots";
import { advance, nextMidnight, spreadMs, type CollectCursor } from "./schedule";

/**
 * One connection's daily collect (Connectors 2, ADR-0012), as the lane or the operator script runs
 * it:
 * 1. take the collect lease (60 seconds) in one change, only while it is connected, picked, not
 *    paused, due and not held;
 * 2. open its token as a system job: no grant is checked, because grants say who may see numbers,
 *    not whether the brand keeps them;
 * 3. run the connector's collect hook, which plans and reads the days due;
 * 4. write each day's docs (a whole doc under a fixed id, so a repeat writes the same), and delete
 *    the day 90 days before each new day;
 * 5. once a day after a day lands, rewrite the rolled 28 and 90 day docs (src/lib/connectors/rollups.ts);
 * 6. under the lease, move the cursor over the days that landed, set when to look next, and record
 *    the outcome: a refused token through the same outcomePlan a live read uses, so the connection
 *    shows broken and goes to Review; a quota answer only as the collector's own hold, so live reads
 *    go on.
 * A run that loses its lease (it ran out) leaves the cursor alone: its docs are written again next
 * time. A run that finds the connection disconnected or its generation changed marks what it wrote
 * for erasing.
 */

export const LEASE_MS = 60_000;
/** No new day or call starts with less than this left, of the lane's time or of the lease. */
export const MIN_START_MS = 10_000;
/** Search Console is probed every 2 hours until a new day shows, at most 6 times a Pacific day. */
export const PROBE_EVERY_MS = 2 * 3_600_000;
export const PROBES_PER_DAY = 6;
/** A quota answer holds collecting 15 minutes; a second the same day holds it to the next midnight. */
export const QUOTA_HOLD_MS = 15 * 60_000;
/** Failed tries a day: after 2 the collector waits an hour, after 3 until the next day. */
export const ERRORS_BEFORE_HOUR = 2;
export const ERRORS_BEFORE_DAY = 3;
const HOUR_MS = 3_600_000;
/** The lane runs every 30 minutes: "next run" is any time before then. */
const NEXT_RUN_MS = 0;

/** Google's quotas reset at midnight Pacific time; a stream with a zone of its own counts days there. */
const quotaZone = (stream: { timeZone?: string }) => stream.timeZone ?? "America/Los_Angeles";

export interface CollectRunDeps extends ServiceDeps {
  clock?: () => number;
  newLeaseId?: () => string;
  /** The operator script: any known connector, whatever its switch says. */
  anyConnector?: boolean;
}

export interface CollectRunResult {
  status: "collected" | "nothing" | "skipped" | "held" | "failed" | "busy";
  /** Days written this run. */
  days: number;
  code?: string;
}

/** The collect state a record carries, or a fresh one (due now) for a record from before collecting. */
export function collectOf(conn: Pick<DataConnection, "collect">): CollectState {
  return conn.collect ?? CollectStateSchema.parse({});
}

/** Its cursor, for the hooks and the schedule. */
export const cursorOf = (c: CollectState): CollectCursor => ({ lastDay: c.lastDay, finalThrough: c.finalThrough, backfilledTo: c.backfilledTo, filled: c.filled, timeZone: c.timeZone });

/**
 * Whether the lane should collect it now: connected, a site or property picked, not paused, not
 * turned down, its connector on with a collect hook, due and not held, and no run holding it.
 */
export function isDue(conn: DataConnection, now: Date, manifest: ConnectorManifest | null = getConnector(conn.connectorId)): boolean {
  if (conn.status !== "connected" || !conn.account || conn.pausedAt || conn.health.state === "broken") return false;
  if (!manifest || !manifest.hooks.collect || !collectedStream(manifest) || isCallPaused(conn, now)) return false;
  const c = collectOf(conn);
  const at = now.getTime();
  if (c.leaseUntil && Date.parse(c.leaseUntil) > at) return false;
  if (c.holdUntil && Date.parse(c.holdUntil) > at) return false;
  return !c.nextAt || Date.parse(c.nextAt) <= at;
}

/** The hold, if any, for a run's outcome, and the strikes after it. */
function holdFor(c: CollectState, r: CollectResult, failure: HookFailure | null, stream: { timeZone?: string }, now: Date): { hold: { until: Date; reason: string } | null; strikes: CollectState["strikes"] } {
  const zone = quotaZone(stream);
  const today = todayIn(now, zone);
  const strikes = c.strikes && c.strikes.day === today ? { ...c.strikes } : { day: today, quota: 0, errors: 0 };
  if (r.hold && r.hold.reason !== "no_data") return { hold: { until: new Date(r.hold.untilMs), reason: r.hold.reason }, strikes };
  if (!failure) return { hold: null, strikes: c.strikes && c.strikes.day === today ? strikes : null };
  if (failure.code === "rate_limited") {
    strikes.quota += 1;
    if (strikes.quota >= 2) return { hold: { until: nextMidnight(now, zone), reason: "quota_day" }, strikes };
    const wait = Math.max(QUOTA_HOLD_MS, (failure.retryAfterSec ?? 0) * 1000);
    return { hold: { until: new Date(now.getTime() + wait), reason: "quota" }, strikes };
  }
  if (failure.code === "query_refused") return { hold: { until: nextMidnight(now, zone), reason: "failed_today" }, strikes };
  if (countsAsFailure(failure.code)) {
    strikes.errors += 1;
    if (strikes.errors >= ERRORS_BEFORE_DAY) return { hold: { until: nextMidnight(now, zone), reason: "failed_today" }, strikes };
    if (strikes.errors >= ERRORS_BEFORE_HOUR) return { hold: { until: new Date(now.getTime() + HOUR_MS), reason: "server_errors" }, strikes };
  }
  return { hold: null, strikes };
}

/** When to look next, with the connection's spread over the hour. */
function nextLook(r: CollectResult, landedNew: boolean, probes: CollectState["probes"], cursor: CollectCursor, conn: DataConnection, now: Date): Date {
  const spread = spreadMs(conn.id);
  const due = r.nextDueMs !== null ? new Date(r.nextDueMs + spread) : new Date(now.getTime() + 24 * HOUR_MS);
  // No data from the provider: look again when the next day is due, not every run.
  if (r.hold?.reason === "no_data") return due;
  if (r.moreDue || !cursor.filled) return new Date(now.getTime() + NEXT_RUN_MS);
  if (r.probed && !landedNew && (probes?.count ?? 0) < PROBES_PER_DAY) return new Date(Math.min(due.getTime(), now.getTime() + PROBE_EVERY_MS));
  return due.getTime() > now.getTime() ? due : new Date(now.getTime() + PROBE_EVERY_MS);
}

/** The busiest grouping of the newest day that landed: what the Connected view says was kept. */
function keptOf(written: Array<{ day: string; by: string; seen: number; kept: number; more: boolean }>, before: CollectState["kept"]): CollectState["kept"] {
  const newest = written.map((w) => w.day).sort().at(-1);
  if (!newest) return before;
  const busiest = written.filter((w) => w.day === newest && w.by !== "day").sort((a, b) => b.seen - a.seen)[0];
  return busiest ? { day: newest, by: busiest.by, seen: busiest.seen, rows: busiest.kept, more: busiest.more } : before;
}

/**
 * Collect one connection now, if it is due (or `force`, from the operator script, which still
 * respects a lease and a pause). Never throws for a provider's answer; a Firestore failure throws
 * to the lane, which logs it and goes on.
 */
export async function collectConnection(ctx: TenantContext, id: string, opts: { deadlineMs: number; force?: boolean }, deps: CollectRunDeps = {}): Promise<CollectRunResult> {
  const clock = deps.clock ?? (() => (deps.now ?? new Date()).getTime());
  const now = new Date(clock());
  const leaseId = (deps.newLeaseId ?? (() => randomBytes(12).toString("hex")))();
  const manifestOf = (c: DataConnection) => (deps.anyConnector ? knownConnector(c.connectorId) : getConnector(c.connectorId));

  // 1. The lease.
  const claimed = await changeDataConnection(
    ctx,
    id,
    (cur) => {
      const m = manifestOf(cur);
      if (opts.force ? cur.status !== "connected" || !cur.account || cur.pausedAt || !m?.hooks.collect : !isDue(cur, now, m)) return null;
      const c = collectOf(cur);
      if (c.leaseUntil && Date.parse(c.leaseUntil) > now.getTime()) return null;
      return { patch: { collect: { ...c, leaseId, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() } }, activity: [] };
    },
    deps.db,
  );
  if (!claimed.ok) return { status: "skipped", days: 0 };
  const conn = claimed.connection;
  const manifest = manifestOf(conn)!;
  const stream = collectedStream(manifest)!;
  const hook = COLLECT_HOOKS[manifest.hooks.collect!];
  const start = collectOf(conn);
  const owner = { id: conn.id, connectorId: conn.connectorId, account: conn.account, gen: start.gen };

  // 2. The token, as a system job.
  const token = hook ? await connectionToken(ctx, conn, manifest, "system", deps) : null;
  if (!hook || !token || !token.ok) {
    const failure: HookFailure | null = token && !token.ok ? { ok: false, code: token.code, retryAfterSec: token.retryAfterSec } : null;
    await release(ctx, id, leaseId, owner.gen, deps, (cur, c) => {
      const o = failure && !(token && !token.ok && token.recorded) ? outcomePlan(cur, failure, SYSTEM, now, null) : null;
      const next = {
        ...c,
        failedSince: failure && countsAsFailure(failure.code) ? (c.failedSince ?? now.toISOString()) : c.failedSince,
        nextAt: new Date(now.getTime() + (failure?.code === "busy" ? NEXT_RUN_MS : HOUR_MS)).toISOString(),
      };
      return { patch: { ...(o?.patch ?? {}) }, activity: o?.activity ?? [], collect: next };
    });
    return { status: failure?.code === "busy" ? "busy" : "failed", days: 0, ...(failure ? { code: failure.code } : {}) };
  }

  // 3. The hook, within the lane's time and the lease.
  const leaseEnds = now.getTime() + LEASE_MS;
  const canStart = () => {
    const t = clock();
    return opts.deadlineMs - t >= MIN_START_MS && leaseEnds - t >= MIN_START_MS;
  };
  const r = await hook(
    { manifest, connection: conn, account: conn.account, token: token.token, ask: { stream, cursor: cursorOf(start), now, canStart } },
    deps,
  );

  // 4. The days, each grouping a whole doc; a new day also drops the day 90 days before it.
  const written: Array<{ day: string; by: string; seen: number; kept: number; more: boolean }> = [];
  const landed: Array<{ day: string; final: boolean }> = [];
  for (const day of r.days) {
    for (const doc of day.docs) {
      const w = await writeDayDoc(
        ctx,
        { owner, stream: stream.stream, by: doc.by, day: day.day, timeZone: r.timeZone, final: day.final, totals: doc.totals, rows: doc.rows, more: doc.more, basis: doc.basis ?? null, notes: doc.notes ?? [], keepDays: stream.collect.keepDays },
        deps,
      );
      written.push({ day: day.day, by: doc.by, seen: w.seen, kept: w.kept, more: doc.more });
    }
    if (!start.lastDay || day.day > start.lastDay) await dropAgedDay(ctx, owner, stream.stream, stream.collect.by, day.day, stream.collect.keepDays, deps);
    landed.push({ day: day.day, final: day.final });
  }

  // 5. The cursor and what comes next, under the lease. A shared connection's refusals read in its
  // own words, as a live read's do.
  const failure: HookFailure | null = r.failure ? { ...r.failure, code: codeFor(conn, r.failure.code) } : null;
  const cursor = advance(cursorOf(start), landed, { newest: r.newest, keepDays: stream.collect.keepDays, reachFrom: r.reachFrom, timeZone: r.timeZone });

  // 6. Once a day after a day lands (and when the backfill fills), the rolled 28 and 90 day docs.
  const rolledDay = todayIn(now, "UTC");
  let rolledOn = start.rolledOn;
  if (landed.length && cursor.lastDay && cursor.backfilledTo && (start.rolledOn !== rolledDay || (cursor.filled && !start.filled)) && canStart()) {
    try {
      await rollConnection(
        ctx,
        { owner, stream: stream.stream, by: stream.collect.by, keepDays: stream.collect.keepDays, lastDay: cursor.lastDay, backfilledTo: cursor.backfilledTo, timeZone: r.timeZone },
        deps,
      );
      rolledOn = rolledDay;
    } catch (err) {
      console.warn(`[connectors] rolling ${conn.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  const landedNew = landed.some((l) => !start.lastDay || l.day > start.lastDay);
  const probeDay = todayIn(now, quotaZone(stream));
  const probes = r.probed ? { day: probeDay, count: start.probes?.day === probeDay ? start.probes.count + 1 : 1 } : start.probes;
  const { hold, strikes } = holdFor(start, r, failure, stream, now);
  const noData = r.hold?.reason === "no_data";
  const worked = landed.length > 0 || (!failure && (r.probed || r.days.length > 0 || r.newest !== null));
  await release(ctx, id, leaseId, owner.gen, deps, (cur, c) => {
    const o =
      failure && failure.code !== "rate_limited" && failure.code !== "busy"
        ? outcomePlan(cur, failure, SYSTEM, now, null)
        : worked || noData
          ? outcomePlan(cur, { ok: true }, SYSTEM, now, landed.length ? "collected" : null)
          : null;
    const next: CollectState = {
      ...c,
      ...cursor,
      reachFrom: r.reachFrom ?? c.reachFrom,
      rolledOn,
      kept: keptOf(written, c.kept),
      probes,
      strikes,
      holdUntil: hold ? hold.until.toISOString() : noData ? null : c.holdUntil && Date.parse(c.holdUntil) > now.getTime() ? c.holdUntil : null,
      holdReason: hold ? hold.reason : noData ? "no_data" : null,
      failedSince: failure && countsAsFailure(failure.code) && failure.code !== "rate_limited" ? (c.failedSince ?? now.toISOString()) : worked ? null : c.failedSince,
      // A failure is tried again at the next run, or as soon as its hold ends.
      nextAt: (failure ? (hold?.until ?? now) : nextLook(r, landedNew, probes, cursor, cur, now)).toISOString(),
    };
    return { patch: o?.patch ?? {}, activity: o?.activity ?? [], collect: next };
  });
  if (failure) return { status: failure.code === "busy" ? "busy" : hold ? "held" : "failed", days: landed.length, code: failure.code };
  if (hold) return { status: "held", days: landed.length };
  return { status: landed.length ? "collected" : "nothing", days: landed.length };
}

/**
 * Give the lease back with the run's state, in one change. A connection disconnected meanwhile, or
 * whose generation moved on (Change property), gets what this run wrote marked for erasing first,
 * whoever holds the lease now: Disconnect clears it, and Change property takes its own, and either
 * may have erased before this run's last write. Otherwise a lease that ran out (another run holds
 * it) leaves everything alone.
 */
async function release(
  ctx: TenantContext,
  id: string,
  leaseId: string,
  gen: number,
  deps: CollectRunDeps,
  plan: (cur: DataConnection, c: CollectState) => { patch: DataConnectionPatch; activity: ActivityWrite[]; collect: CollectState },
): Promise<void> {
  await changeDataConnection(
    ctx,
    id,
    (cur) => {
      const c = collectOf(cur);
      const mine = c.leaseId === leaseId;
      if (cur.status !== "connected" || c.gen !== gen) {
        const erasePending = pendingWith(c.erasePending, cur.status !== "connected" ? "all" : [gen]);
        return { patch: { collect: { ...c, ...(mine ? { leaseId: null, leaseUntil: null } : {}), erasePending } }, activity: [] };
      }
      if (!mine) return null;
      const free = { ...c, leaseId: null, leaseUntil: null };
      const p = plan(cur, free);
      return { patch: { ...p.patch, collect: { ...p.collect, leaseId: null, leaseUntil: null } }, activity: p.activity };
    },
    deps.db,
  );
}
