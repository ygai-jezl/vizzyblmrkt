import { readFileSync } from "node:fs";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { fnv1a } from "@/lib/journey/allocation";
import { readLoopLane, writeLoopLane } from "@/lib/tenant/loopLane";
import { loopDayId, mergeLaneState, readBrandPointers, readLaneState, readLoopDays } from "@/lib/tenant/loops";
import { countSuspendedTenants, countTenants, listTenantPage, type TenantPageRow } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { BrandPointersSchema, LaneStateSchema, type BrandPointers, type LaneState } from "@/lib/types/loopDay";
import { clearOldCopy, hasOldCopy } from "./oldCopy";
import { readAttention } from "./attention";
import { expireGoBackCards, goBackOf, openGoBackCards, soonestExpiry } from "./cards";
import { loopWeekOf } from "./count";
import { isLoopsEnabled } from "./flags";
import { foldClosedWeeks, lastClosedWeek } from "./fold";
import { FleetBuffer, heartbeat, type HeartbeatDeps } from "./heartbeat";
import { runImageVerdicts, newVerdictRun, type VerdictRun } from "./imageVerdict";
import { isHolding, newLearnRun, readLoopCounts, runVotesLearner, type HoldState, type LearnRun, type VotesLearnerDeps, type VotesLearnerResult } from "./learners/votes";
import { LOOP_RULES } from "./registry";
import { seedBrand } from "./seed";

/**
 * The loops lane (learning loops steps 4 and 5, 4.5 and 4.6 of the plan for steps 4 and 5), run
 * by the lifecycle tick (src/app/api/admin/lifecycle/tick/route.ts) while image style versions
 * (IMAGE_STYLE_VERSIONS_ENABLED) or the learning loops (LOOPS_ENABLED) are on. Its image parts
 * (the seed, the old copy, cards, the learner and the verdict) run only with image style versions
 * on; the fold runs with either; the heartbeat only with LOOPS_ENABLED.
 *
 * - Cadence: every 5th tick, at offset 1, about every 10 minutes, so it never shares a tick with
 *   the lanes on multiples of 5 or the connectors lane (every 15th, at offset 7).
 * - Memory guard: it skips its run, and logs "[loops] skipped: memory", when the instance holds
 *   more than 600 MiB, or more than 60% of its container's limit where that can be read.
 * - Which brands: a page of K brands in document id order (listTenantPage), from the cursor kept
 *   on `loop_lane`'s `lane` document: 1 read and 1 write a run. K is N / 144, kept between 5 and
 *   100, with N the registry counted about weekly, so each brand is visited about once a day.
 * - Per brand, 4 at a time, each step stopping at the deadline:
 *   1. the idle check, one batched read of `lb:`, `ls:` and (for the image parts) the open week's
 *      5 shards: a brand folded, with no closed week left to report, and, with image style
 *      versions on, seeded, whose people's signals this week and whose pointers (a Pause or
 *      Resume, an Undo, a Keep) haven't moved since the last full visit, and with nothing due by
 *      time, is left at that;
 *   2. the seed (src/lib/loops/seed.ts), on its first visit;
 *   3. a forgotten look's old copy on the brand record, cleared until it is gone;
 *   4. the fold of closed weeks (src/lib/loops/fold.ts);
 *   5. Go back cards past their 14 days, closed;
 *   6. the votes learner (src/lib/loops/learners/votes.ts), within the run's call budget and the
 *      copy's daily ceiling, counted on the lane document;
 *   7. the verdict for each learned look that is due (src/lib/loops/imageVerdict.ts), at most
 *      LOOP_RULES.laneVerdictReads reads a run, one read held at a time;
 *   8. the heartbeat (src/lib/loops/heartbeat.ts) for each closed and folded week not yet reported,
 *      with LOOPS_ENABLED: the brand's week moves its organisation's mark on `loop_lane`, and the
 *      run adds every brand's credited increments to `fleet_cells` in one batched write at its end.
 * - With LOOPS_ENABLED on, the idle check also waits for a week to report, a brand whose fold is
 *   more than LOOP_RULES.foldBehindDays behind is counted once a week (the fold alarm), and each
 *   closed week's brands listed (suspended brands left out, as the lane skips them) are counted
 *   once, against the brands the heartbeat visited for it (opted out and late ones included).
 * - The lane document keeps the week the learning loops were last turned on in (`loopsOnFrom`):
 *   a run with LOOPS_ENABLED on sets it when it is missing, one with it off takes it away, and no
 *   week before it is reported or listed, as nothing was counted across brands then. With both
 *   switches off nothing runs the lane, so a run that finds the last one more than
 *   LANE.GAP_HOURS ago starts it again from its own week too: the loops may have been off between.
 * - Logs: the route adds "brands=<n> rows=<n> heapDeltaMiB=<n>" to its "[tick] loops <ms>ms"
 *   line, and "[loops] fold behind <days>" shows a fold more than 42 days behind.
 * Nothing is kept between brands. Server only.
 */

export const LANE = {
  TICK_MS: 120_000,
  /** Every 5th tick: about every 10 minutes. */
  EVERY: 5,
  OFFSET: 1,
  /** Runs a day, which the page size spreads the brands over. */
  RUNS_PER_DAY: 144,
  /** Brands visited at once. */
  AT_ONCE: 4,
  /** The registry is counted again after this many days. */
  COUNT_EVERY_DAYS: 7,
  /** No brand visit starts with less than this left. */
  MIN_LEFT_MS: 2_000,
  /** The memory guard: skip at more than 600 MiB held, or more than 60% of the container's limit. */
  RSS_MAX_MIB: 600,
  LIMIT_SHARE: 0.6,
  /** A brand with nothing due by time is still looked at fully after a week. */
  QUIET_MAX_DAYS: 7,
  /**
   * A run that finds the last one longer ago than this sets `loopsOnFrom` to its own week, as
   * nothing runs the lane with both switches off. The lane runs about every 10 minutes, so only
   * a long outage reads as a gap too, which can only undercount.
   */
  GAP_HOURS: 24,
} as const;

const MIB = 1024 * 1024;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A tick the lane runs on: Math.floor(now / 120_000) % 5 === 1. */
export const isLoopsTick = (nowMs: number): boolean => Math.floor(nowMs / LANE.TICK_MS) % LANE.EVERY === LANE.OFFSET;

/** The page size for N brands: about N / 144, kept between LOOP_RULES.laneBrandsMin and laneBrandsMax. */
export function pageSizeFor(n: number): number {
  return Math.min(LOOP_RULES.laneBrandsMax, Math.max(LOOP_RULES.laneBrandsMin, Math.ceil(Math.max(0, n) / LANE.RUNS_PER_DAY)));
}

/** The container's memory limit in bytes (cgroup v2), or null where it can't be read or is unlimited. */
export function containerMemoryLimit(read: (path: string) => string = (p) => readFileSync(p, "utf8")): number | null {
  try {
    const raw = read("/sys/fs/cgroup/memory.max").trim();
    const n = Number(raw);
    return raw !== "max" && Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Whether the instance holds too much memory for the lane to start. */
export function memoryTooHigh(rss: number, limit: number | null): boolean {
  if (rss > LANE.RSS_MAX_MIB * MIB) return true;
  return limit !== null && rss > limit * LANE.LIMIT_SHARE;
}

type Tree = Record<string, unknown>;
const isObj = (v: unknown): v is Tree => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * A hash of what people did this week (`c` and `o` of the open week's shards), so a visit can see
 * nothing moved since the last full one. The lane's own counts (`r` and `k`) are left out, so a
 * visit's own refusals never make the next visit busy.
 */
export function signalHash(shards: readonly unknown[]): string {
  const leaves: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === "number") {
      if (node !== 0) leaves.push(`${path}=${node}`);
      return;
    }
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}/${k}` : k);
  };
  // Shards are added up first, so the same totals hash the same whichever shard they landed in.
  const sum: Tree = {};
  const add = (into: Tree, from: unknown) => {
    if (!isObj(from)) return;
    for (const [k, v] of Object.entries(from)) {
      if (typeof v === "number") into[k] = ((into[k] as number | undefined) ?? 0) + v;
      else if (isObj(v)) add((isObj(into[k]) ? into[k] : (into[k] = {})) as Tree, v);
    }
  };
  for (const d of shards) if (isObj(d)) add(sum, { c: d.c, o: d.o });
  walk(sum, "");
  return fnv1a(leaves.sort().join(";")).toString(36);
}

/** A value with its keys in order, so the same pointers always hash the same. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
}

/**
 * What the idle check compares: the open week's signals (signalHash) and the brand's pointers, so a
 * person's Resume, Undo or Keep, which write only `lb:`, makes the next visit full.
 */
export function visitHash(shards: readonly unknown[], pointers: BrandPointers): string {
  return fnv1a(`${signalHash(shards)}|${JSON.stringify(stable(pointers))}`).toString(36);
}

/** Go back cards the open week counted already, for the weekly budget. */
function cardsProposed(shards: readonly unknown[]): number {
  let n = 0;
  for (const d of shards) {
    const k = isObj(d) && isObj(d.k) && isObj(d.k.loop_learn) ? d.k.loop_learn : null;
    if (k && typeof k.proposed === "number") n += k.proposed;
  }
  return n;
}

export interface LoopsLaneDeps {
  /** The brand's regional database (tests pass one fake for every region). */
  db?: FirestoreLike;
  /** The control plane database, for the registry and the lane document. */
  controlDb?: FirestoreLike;
  now?: () => Date;
  clock?: () => number;
  /** Run whatever the tick's number (tests, and a run asked for by hand). */
  anyTick?: boolean;
  /** The instance's memory, for the guard. */
  memory?: () => { rss: number; heapUsed: number };
  memoryLimit?: () => number | null;
  /** The learner's own dependencies (the model, the profile), for tests. */
  learner?: Pick<VotesLearnerDeps, "synthesize" | "profile" | "configured" | "log" | "loadTenant">;
  /** The brand's open Go back cards (openGoBackCards by default), for tests. */
  openCards?: typeof openGoBackCards;
  /** A brand's usage meter for a month (usageThisMonth by default), for the heartbeat's calls, for tests. */
  usage?: HeartbeatDeps["usage"];
}

export interface LoopsLaneResult {
  skipped?: "switch" | "tick" | "memory";
  /** Brands visited, idle ones included. */
  brands: number;
  idle: number;
  /** Image rows read by the learner and the verdicts. */
  rows: number;
  learned: number;
  verdicts: number;
  /** Brands the run reached, in order (for tests, and the coverage line in the counts across brands). */
  visited: string[];
  /** Brand weeks the heartbeat reported, and those dropped as late (LOOPS_ENABLED). */
  reported: number;
  late: number;
  /** Rows of the counts across brands the run added to. */
  cells: number;
  heapDeltaMiB: number;
}

interface BrandVisit {
  idle: boolean;
  rows: number;
  learned: number;
  verdicts: number;
  reported: number;
  late: number;
}

/** The fold alarm's weeks behind are counted up to this many, as 10 or more. */
const BEHIND_WEEKS_MAX = 10;

/** The looks the brand record held before versions, as the seed reads them, from the projected row. */
function legacyTenantOf(row: TenantPageRow): Pick<Tenant, "brandKit" | "imageStyle"> {
  const learned = Object.fromEntries(Object.entries(row.styleLooks).map(([k, v]) => [k, { directive: v.directive, sampleCount: 0, updatedAt: v.updatedAt ?? "" }]));
  return {
    brandKit: row.learnedImageStyle ? ({ learnedImageStyle: row.learnedImageStyle } as Tenant["brandKit"]) : undefined,
    imageStyle: Object.keys(learned).length ? ({ defaultStyleId: null, learned } as unknown as Tenant["imageStyle"]) : undefined,
  };
}

/**
 * Whether a worse read goes to the card's own notice on What it learned instead of a Go back card:
 * on a copy without Review (nav v2 phase 2 off), which has nowhere to answer a card, and under the
 * attention rule.
 */
export async function cardsAsNotice(ctx: TenantContext, pointers: Pick<BrandPointers, "cardsResumedAt">, deps: { now: Date; db?: FirestoreLike }): Promise<boolean> {
  if (!isNavV2Phase2Enabled()) return true;
  return (await readAttention(ctx, { now: deps.now, cardsResumedAt: pointers.cardsResumedAt, db: deps.db })).cards.noticeOnly;
}

/** One brand's visit. Never throws for the brand's own trouble. */
async function visitBrand(row: TenantPageRow, run: { learn: LearnRun; verdicts: VerdictRun; deadlineMs: number; fleet: FleetBuffer; loopsOnFrom?: string }, deps: LoopsLaneDeps): Promise<BrandVisit> {
  const ctx: TenantContext = { tenantId: row.id, region: row.region, source: "system" };
  const now = (deps.now ?? (() => new Date()))();
  const clock = deps.clock ?? Date.now;
  const db = deps.db;
  const out: BrandVisit = { idle: false, rows: 0, learned: 0, verdicts: 0, reported: 0, late: 0 };
  const versions = isImageStyleVersionsOn();
  const loopsOn = isLoopsEnabled();

  // 1. The idle check: one batched read (the open week's shards only for the image parts).
  const week = loopWeekOf(now);
  const lastClosed = lastClosedWeek(now);
  const shardIds = versions ? Array.from({ length: LOOP_RULES.shards }, (_, i) => loopDayId.week(ctx.tenantId, week, i)) : [];
  const [lb, ls, ...shardDocs] = await readLoopDays(ctx, [loopDayId.brand(ctx.tenantId), loopDayId.lane(ctx.tenantId), ...shardIds], db);
  const pointers0 = BrandPointersSchema.safeParse(lb?.d ?? {});
  let pointers: BrandPointers = pointers0.success ? pointers0.data : BrandPointersSchema.parse({});
  const lane0 = LaneStateSchema.safeParse(ls?.d ?? {});
  const lane: LaneState = lane0.success ? lane0.data : {};
  const shards = shardDocs.map((d) => d?.d);
  const hash = visitHash(shards, pointers);
  const folded = Boolean(lane.foldedThrough && lane.foldedThrough >= lastClosed);
  // With LOOPS_ENABLED, a closed week not yet reported keeps the visit full.
  const beatDue = loopsOn && !(lane.heartbeatWeek && lane.heartbeatWeek >= lastClosed);
  const forgotPending = versions ? Object.entries(pointers.forgot ?? {}).filter(([scope, { at }]) => hasOldCopy(row, scope, at)) : [];
  const quiet = lane.seen?.week === week && lane.seen.hash === hash && Boolean(lane.quietUntil) && now.toISOString() < lane.quietUntil!;
  const imagesIdle = !versions || (Boolean(pointers.seededAt) && forgotPending.length === 0 && quiet);
  if (folded && !beatDue && imagesIdle) {
    out.idle = true;
    return out;
  }

  if (versions) {
    // 2. The seed, once.
    if (!pointers.seededAt) {
      const seeded = await seedBrand(ctx, legacyTenantOf(row), { db, now });
      if (!seeded.ok) return out;
      pointers = await readBrandPointers(ctx, db);
    }

    // 3. A forgotten look's old copy on the brand record, until it is gone.
    for (const [scope, { at }] of forgotPending) await clearOldCopy(ctx, row, scope, at, { controlDb: deps.controlDb });
  }

  // 4. The fold.
  let foldedThrough = lane.foldedThrough;
  /** The fold alarm across brands: how many weeks behind the fold was, counted once a week. */
  let behindWeeks: number | null = null;
  if (!folded) {
    const f = await foldClosedWeeks(ctx, lane.foldedThrough, { db, now });
    if (f.foldedThrough) foldedThrough = f.foldedThrough;
    // A brand folded before that has fallen behind; a brand's first fold starts at the oldest week kept.
    // The alarm across brands goes to the last closed week, so not when that week is from before the
    // loops came back on: no week before loopsOnFrom is written (a turn on run catches up the fold).
    if (lane.foldedThrough && f.behindDays !== null && f.behindDays > LOOP_RULES.foldBehindDays) {
      console.warn(`[loops] fold behind ${f.behindDays}`);
      const inLoopsWeeks = !run.loopsOnFrom || lastClosed >= run.loopsOnFrom;
      if (loopsOn && inLoopsWeeks && !pointers.fleetOptOut && lane.behindWeek !== lastClosed) behindWeeks = Math.min(BEHIND_WEEKS_MAX, Math.ceil(f.behindDays / 7));
    }
  }
  if (run.deadlineMs - clock() < LANE.MIN_LEFT_MS) return out;

  let quietUntil: string | undefined;
  if (versions) {
    // 5. Go back cards past their 14 days.
    let cardsRead = true;
    const open = await (deps.openCards ?? openGoBackCards)(ctx, { db, now }).catch(() => {
      cardsRead = false;
      return [];
    });
    await expireGoBackCards(ctx, { db, now }).catch(() => 0);

    // 6. The votes learner. It never runs on a scope whose Go back card is open, so when the cards
    // couldn't be read it waits for the next visit instead of learning past one.
    let retry = !cardsRead;
    let weekWait: string | null = null;
    const holds = new Map<string, HoldState>();
    const learned: VotesLearnerResult = cardsRead
      ? await runVotesLearner(ctx, run.learn, {
          db,
          now,
          clock,
          laneState: await readLaneState(ctx, db),
          // The cards read above, past their 14 days left out: no second read.
          goBackOpen: async () => new Set(open.flatMap((a) => goBackOf(a)?.scope ?? [])),
          ...(deps.learner ?? {}),
        })
      : { outcomes: [], readRows: false };
    out.rows += learned.rows ?? 0;
    for (const o of learned.outcomes) {
      if (o.outcome === "learned") out.learned += 1;
      if (o.outcome === "refused" && (o.reason === "error" || o.reason === "budget")) retry = true;
      if (o.outcome === "waiting" && o.why === "unprofiled") retry = true;
      if (o.outcome === "waiting" && o.why === "hold" && o.hold) holds.set(o.scope, o.hold);
      if (o.outcome === "waiting" && o.why === "week") {
        const adopted = pointers.scopes[o.scope]?.adoptedAt;
        const at = adopted ? new Date(Date.parse(adopted) + LOOP_RULES.learnEveryDays * DAY_MS).toISOString() : null;
        if (at && (!weekWait || at < weekWait)) weekWait = at;
      }
    }
    if (out.learned > 0) pointers = await readBrandPointers(ctx, db);

    // 7. The verdicts.
    let dueAt: string | null = null;
    if (run.deadlineMs - clock() >= LANE.MIN_LEFT_MS) {
      const counts = await readLoopCounts(ctx, pointers, { now, db });
      const v = await runImageVerdicts(ctx, pointers, counts.versions, run.verdicts, {
        db,
        now,
        proposedThisWeek: cardsProposed(shards),
        noticeOnly: () => cardsAsNotice(ctx, pointers, { now, db }),
      });
      out.rows += v.rows;
      out.verdicts += v.verdicts.length;
      dueAt = v.dueAt;
      // A read that ended a look's hold, or one that waited for the budget, needs the next visit to be full.
      const freed = v.verdicts.some((x) => {
        const hold = holds.get(x.scope);
        return hold !== undefined && !isHolding({ ...hold, counted: x.check.counted, settled: x.check.settled });
      });
      if (freed || v.deferred) retry = true;
    } else retry = true;

    // When nothing is due by time alone, until the next full visit.
    const times = [weekWait, dueAt, soonestExpiry(open), new Date(now.getTime() + LANE.QUIET_MAX_DAYS * DAY_MS).toISOString()].filter((t): t is string => !!t);
    quietUntil = retry ? now.toISOString() : times.sort()[0]!;
  }

  // 8. The heartbeat, for each closed and folded week not yet reported.
  if (beatDue && run.deadlineMs - clock() >= LANE.MIN_LEFT_MS) {
    const beat = await heartbeat(ctx, row, { lane, pointers, foldedThrough, loopsOnFrom: run.loopsOnFrom }, run.fleet, { db, controlDb: deps.controlDb, now, usage: deps.usage });
    out.reported += beat.weeks - beat.late;
    out.late += beat.late;
  }

  // The pointers as the visit left them: a seed or a look it learned is not a change to look at again.
  const kept = await mergeLaneState(
    ctx,
    {
      ...(versions && quietUntil ? { seen: { week, hash: visitHash(shards, pointers) }, quietUntil } : {}),
      ...(behindWeeks !== null ? { behindWeek: lastClosed } : {}),
      runs: (lane.runs ?? 0) + 1,
      lastRunAt: now.toISOString(),
    },
    db,
  ).then(
    () => true,
    (err: unknown) => {
      console.warn("[loops] keeping the lane's state failed", err instanceof Error ? err.message.slice(0, 200) : "error");
      return false;
    },
  );
  // Counted once the brand keeps the week it was counted for, so a rerun never counts it again.
  if (kept && behindWeeks !== null) run.fleet.add(lastClosed, `_orgs/foldBehind/w${behindWeeks}`, 1);
  return out;
}

/** Run `fn` over `items`, `n` at a time, in order of start. */
async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** The lane's run: its brands, their visits, the lane document moved on, and the run's counts across brands written. */
export async function runLoopsLane(opts: { deadlineMs: number }, deps: LoopsLaneDeps = {}): Promise<LoopsLaneResult> {
  const result: LoopsLaneResult = { brands: 0, idle: 0, rows: 0, learned: 0, verdicts: 0, visited: [], reported: 0, late: 0, cells: 0, heapDeltaMiB: 0 };
  const loopsOn = isLoopsEnabled();
  if (!isImageStyleVersionsOn() && !loopsOn) return { ...result, skipped: "switch" };
  const now = (deps.now ?? (() => new Date()))();
  const clock = deps.clock ?? Date.now;
  if (!deps.anyTick && !isLoopsTick(now.getTime())) return { ...result, skipped: "tick" };
  const memory = deps.memory ?? (() => process.memoryUsage());
  const before = memory();
  if (memoryTooHigh(before.rss, (deps.memoryLimit ?? containerMemoryLimit)())) {
    console.log("[loops] skipped: memory");
    return { ...result, skipped: "memory" };
  }

  const doc = await readLoopLane(deps.controlDb);
  const today = now.toISOString().slice(0, 10);
  let n = doc.n;
  let nAt = doc.nAt;
  if (n === undefined || !nAt || now.getTime() - Date.parse(nAt) > LANE.COUNT_EVERY_DAYS * DAY_MS) {
    n = await countTenants(deps.controlDb);
    nAt = now.toISOString();
  }
  const k = pageSizeFor(n);
  const page = await listTenantPage(doc.cursor, k, deps.controlDb);
  // The end of the registry: start again from the first brand to fill the page.
  const wrapped = page.length < k ? (await listTenantPage(null, k - page.length, deps.controlDb)).filter((r) => !page.some((p) => p.id === r.id)) : [];
  const brands = [...page, ...wrapped];
  const cursor = brands.length ? brands[brands.length - 1]!.id : null;

  const callsToday = doc.day === today ? (doc.calls ?? 0) : 0;
  // The week the learning loops were last turned on in: this run's open week when they just came
  // on, and none while they are off, so a later turn on starts again from its own week. A run
  // after a gap (both switches may have been off, and then nothing runs the lane) starts it again
  // too, so no week from that time is reported or listed.
  const lastRunMs = doc.at ? Date.parse(doc.at) : NaN;
  const gap = Number.isFinite(lastRunMs) && now.getTime() - lastRunMs > LANE.GAP_HOURS * HOUR_MS;
  const loopsOnFrom = loopsOn ? ((gap ? undefined : doc.loopsOnFrom) ?? loopWeekOf(now)) : undefined;
  const fleet = new FleetBuffer();
  const run = { learn: newLearnRun({ deadlineMs: opts.deadlineMs, callsToday }), verdicts: newVerdictRun(), deadlineMs: opts.deadlineMs, fleet, loopsOnFrom };
  await pool(brands, LANE.AT_ONCE, async (row) => {
    if (row.status === "suspended" || opts.deadlineMs - clock() < LANE.MIN_LEFT_MS) return;
    result.brands += 1;
    result.visited.push(row.id);
    try {
      const v = await visitBrand(row, run, deps);
      if (v.idle) result.idle += 1;
      result.rows += v.rows;
      result.learned += v.learned;
      result.verdicts += v.verdicts;
      result.reported += v.reported;
      result.late += v.late;
    } catch (err) {
      console.warn(`[loops] ${row.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  });

  // Each closed week's brands listed, counted once: the lane document keeps the week first, so a
  // run that can't keep it adds none. Suspended brands are left out, as the lane never visits them.
  const lastClosed = lastClosedWeek(now);
  // A week from before the loops came back on is never listed: no brand reports it.
  let listNow = loopsOn && !(loopsOnFrom && lastClosed < loopsOnFrom) && (!doc.listedWeek || doc.listedWeek < lastClosed);
  let listed = 0;
  if (listNow) {
    try {
      listed = Math.max(0, n - (await countSuspendedTenants(deps.controlDb)));
    } catch (err) {
      // Listed again next run, once suspended brands can be counted.
      console.warn("[loops] counting suspended brands failed", err instanceof Error ? err.message.slice(0, 200) : "error");
      listNow = false;
    }
  }
  const listedWeek = listNow ? lastClosed : doc.listedWeek;
  try {
    await writeLoopLane(
      { cursor, n, nAt, day: today, calls: callsToday + run.learn.calls, at: now.toISOString(), ...(listedWeek ? { listedWeek } : {}), ...(loopsOnFrom ? { loopsOnFrom } : {}) },
      deps.controlDb,
    );
    if (listNow) fleet.add(lastClosed, "_orgs/listed", listed);
  } catch (err) {
    console.warn("[loops] keeping the lane's cursor failed", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  // The run's counts across brands, in one batched write.
  if (fleet.size) result.cells = await fleet.flush(deps.controlDb);
  result.heapDeltaMiB = Math.round(((memory().heapUsed - before.heapUsed) / MIB) * 10) / 10;
  return result;
}
