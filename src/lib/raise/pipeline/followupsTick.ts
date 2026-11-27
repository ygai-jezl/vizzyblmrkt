import { readFieldList } from "@/lib/audience/fieldList";
import { offsetMs } from "@/lib/lifecycle/sendWindow";
import { listAllTenants } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { RecordField } from "@/lib/types/recordField";
import type { Tenant } from "@/lib/types/tenant";
import { zoneOf } from "@/lib/views/evaluate";
import { readPipeline, type ColumnRole } from "./board";
import { raiseFieldsOf } from "./fields";
import { isRaiseFollowupsEnabled } from "./flags";
import { personValues, proposeFollowUps, reconcileFollowUps } from "./followups";

/**
 * The follow-ups lane of the lifecycle tick (RAISE_FOLLOWUPS_ENABLED). The tick runs every 2
 * minutes; this lane runs on every 30th, at offset 13 (about hourly), so it never shares a tick
 * with the lanes on multiples of 5 or 15, nor the connectors lane's 7 of 15, and has its own 15
 * second budget. No brand starts with under 3 seconds left. No AI, no fetch.
 *
 * Brands in their morning go first, then the rest, suspended ones skipped. Each group takes turns
 * from a rotating start, and the morning group's start moves a quarter of the way round each run, so
 * its four morning runs between them start at every part of it. Only brands set up for the board
 * are read. For each: its open and in play stages (500 people a stage, the most recently active),
 * then its open follow-ups put in step with their people at any hour (a moved Stage sets one aside,
 * a new date marks it acted, 14 days untouched lets it go). Only while it is 6 to 9 in the morning
 * in the brand's own time zone (UTC when it has none) are new follow-ups raised: at most 50 open a
 * brand and 25 new a run. Raising is idempotent, so the four morning runs give one. A brand that had
 * a board and no longer has one (its Stage archived) has its open follow-ups set aside as stale.
 */

export const LANE = {
  TICK_MS: 120_000,
  /** Every 30th tick: about hourly. */
  EVERY: 30,
  OFFSET: 13,
  BUDGET_MS: 15_000,
  /** No brand starts with less than this left. */
  MIN_START_MS: 3_000,
  /** People read a stage. */
  COLUMN_READ: 500,
  MAX_OPEN: 50,
  /** New follow-ups one brand gets a run. */
  MAX_NEW: 25,
  MORNING_FROM: 6,
  MORNING_TO: 9,
} as const;

/** A tick the lane runs on: Math.floor(now / 120_000) % 30 === 13. */
export const isFollowUpTick = (nowMs: number) => Math.floor(nowMs / LANE.TICK_MS) % LANE.EVERY === LANE.OFFSET;

/** The hour on the wall clock in a time zone. */
export function localHour(nowMs: number, timeZone: string | null | undefined): number {
  const tz = zoneOf(timeZone);
  return new Date(nowMs + offsetMs(tz, nowMs)).getUTCHours();
}

/** 6 to 9 in the morning, the brand's time. */
export function isMorning(nowMs: number, timeZone: string | null | undefined): boolean {
  const h = localHour(nowMs, timeZone);
  return h >= LANE.MORNING_FROM && h <= LANE.MORNING_TO;
}

export interface FollowUpsDeps {
  listTenants?: () => Promise<Tenant[]>;
  db?: FirestoreLike;
  /** A region's database (tests pass one per region). */
  regionDb?: (region: string) => FirestoreLike | undefined;
  clock?: () => number;
  log?: (line: string) => void;
}

export interface FollowUpsResult {
  brands: number;
  proposed: number;
  acted: number;
  cleared: number;
  expired: number;
}

const READ_ROLES: ReadonlySet<ColumnRole> = new Set(["open", "active"]);

/** A People field that carries a ready-made marker, archived or not: the brand was set up once. */
const wasSetUp = (items: readonly RecordField[]) => items.some((f) => f.object === "person" && !!f.preset?.startsWith("raise."));

/**
 * One brand's run: null when it isn't set up for the board and has nothing to set aside. A brand
 * that was set up once and has no board now (its Stage archived) has every open follow-up declined
 * as stale, so Review stops showing them; a brand never set up reads nothing more.
 */
export async function followUpBrand(
  ctx: TenantContext,
  timeZone: string | null | undefined,
  opts: { nowMs: number; stop: () => boolean },
  db?: FirestoreLike,
): Promise<Omit<FollowUpsResult, "brands"> | null> {
  const list = await readFieldList(ctx, "person", db);
  const rf = raiseFieldsOf(list.items);
  const now = new Date(opts.nowMs);
  if (!rf.setUp || !rf.stage) {
    if (!wasSetUp(list.items)) return null;
    // No board: nobody reads as in step, so each open one is declined (stale, or expired once past its day).
    const gone = await reconcileFollowUps(ctx, { now, stop: opts.stop, valuesOf: async () => null }, db);
    if (!gone.acted && !gone.cleared && !gone.expired) return null;
    return { proposed: 0, acted: gone.acted, cleared: gone.cleared, expired: gone.expired };
  }
  const board = await readPipeline(ctx, { cap: LANE.COLUMN_READ, roles: READ_ROLES, items: list.items, timeZone: timeZone ?? null }, { db, now: () => now });
  if (!board.setUp) return null;
  // People as the board read them, by field id; anyone else is read by id.
  const ids = { stage: rf.stage.field.key, lastTouch: rf.byPreset["raise.last_touch"]?.key, nextStepDate: rf.byPreset["raise.next_step_date"]?.key };
  const cards = board.columns.flatMap((c) => c.cards);
  const read = new Map(
    cards.map((c) => [
      c.id,
      { [ids.stage]: c.stageOptionId, ...(ids.lastTouch ? { [ids.lastTouch]: c.lastTouch } : {}), ...(ids.nextStepDate ? { [ids.nextStepDate]: c.nextStepDate } : {}) } as Record<string, unknown>,
    ]),
  );
  const kept = await reconcileFollowUps(
    ctx,
    {
      now,
      stop: opts.stop,
      // A card holds the board's fields as they are now, so a follow-up made from a field the board no
      // longer uses reads as moved on; someone not on a stage read here is read by id.
      valuesOf: async (personId) => read.get(personId) ?? personValues(ctx, personId, db),
    },
    db,
  );
  let proposed = 0;
  if (isMorning(opts.nowMs, timeZone)) {
    const due = cards.filter((c) => c.due.length);
    const r = await proposeFollowUps(ctx, due, { fields: ids, now, openNow: kept.open, maxOpen: LANE.MAX_OPEN, maxNew: LANE.MAX_NEW, stop: opts.stop }, db);
    proposed = r.created;
  }
  return { proposed, acted: kept.acted, cleared: kept.cleared, expired: kept.expired };
}

/** A list turned to start at `offset`. */
const rotate = <T>(items: readonly T[], offset: number): T[] => (items.length ? [...items.slice(offset % items.length), ...items.slice(0, offset % items.length)] : []);

/**
 * The order brands are read in one run: those in their 6 to 9 morning first, as only they can be
 * given new follow-ups, then the rest, which only put open ones in step. The rest take turns one
 * brand further on each run; the morning group's start moves a quarter of the group on each run, so
 * a group longer than one run's budget is still reached across its four morning runs. Pure.
 */
export function runOrder<T extends Pick<Tenant, "timeZone">>(tenants: readonly T[], nowMs: number): T[] {
  const run = Math.floor(nowMs / (LANE.TICK_MS * LANE.EVERY));
  const morning = tenants.filter((t) => isMorning(nowMs, t.timeZone));
  const rest = tenants.filter((t) => !isMorning(nowMs, t.timeZone));
  return [...rotate(morning, run * Math.ceil(morning.length / 4)), ...rotate(rest, run)];
}

export async function runRaiseFollowups(opts: { deadlineMs: number }, deps: FollowUpsDeps = {}): Promise<FollowUpsResult> {
  const result: FollowUpsResult = { brands: 0, proposed: 0, acted: 0, cleared: 0, expired: 0 };
  if (!isRaiseFollowupsEnabled()) return result;
  const clock = deps.clock ?? Date.now;
  if (!isFollowUpTick(clock())) return result;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => t.status !== "suspended");
  const order = runOrder(tenants, clock());
  const stop = () => opts.deadlineMs - clock() < 1_000;
  for (const t of order) {
    if (opts.deadlineMs - clock() < LANE.MIN_START_MS) break;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const db = deps.regionDb?.(t.region) ?? deps.db;
    try {
      const r = await followUpBrand(ctx, t.timeZone, { nowMs: clock(), stop }, db);
      if (!r) continue;
      result.brands += 1;
      result.proposed += r.proposed;
      result.acted += r.acted;
      result.cleared += r.cleared;
      result.expired += r.expired;
    } catch (err) {
      console.warn(`[raise] follow-ups failed for ${t.id}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  (deps.log ?? ((line: string) => console.info(line)))(
    `[raise] follow-ups: ${result.brands} of ${tenants.length} brands, ${result.proposed} raised, ${result.acted} followed up, ${result.cleared} set aside, ${result.expired} expired`,
  );
  return result;
}
