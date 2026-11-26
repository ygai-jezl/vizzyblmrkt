import { isoWeekStart, loopDayId, loopDayTtlAt, mergeLaneState, readLoopDays, readLoopDaysTx, runLoopsTransaction, setLoopDayTx } from "@/lib/tenant/loops";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { loopWeekOf } from "./count";
import { IMAGE_STYLE_SCOPES, LOOP_RULES } from "./registry";

/**
 * The fold (learning loops step 4, 4.5 of the plan for steps 4 and 5): each closed week's counter
 * shards in `loop_days` are added up into the week's folded copy (`lt:`), and, for the scopes
 * whose line learns, into each version's totals (`lv:`), with the lane's `foldedThrough` moved on,
 * all in one regional transaction per week. A rerun adds nothing: a week at or before
 * `foldedThrough` is skipped inside the transaction, and so is a version already folded through
 * it. Every subtree of a shard folds into `lt:` as it is (`c`, `t`, `u`, `r`, `k` and `o`), so the
 * likes on a person's own images (`o.image`) are kept too. Server only.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** The most closed weeks one visit folds; a brand further behind catches up over its next visits. */
export const FOLD_WEEKS_PER_VISIT = 12;

/** The week before, and after, an ISO week. */
export const weekBefore = (week: string): string => loopWeekOf(new Date(isoWeekStart(week).getTime() - WEEK_MS));
export const weekAfter = (week: string): string => loopWeekOf(new Date(isoWeekStart(week).getTime() + WEEK_MS));

/** The last closed week at a moment: the week before the open one. */
export const lastClosedWeek = (now: Date): string => weekBefore(loopWeekOf(now));

/** The oldest closed week whose shards may still be kept: their time to live is LOOP_RULES.shardDays after the week ends. */
export function oldestKeptWeek(now: Date): string {
  let week = lastClosedWeek(now);
  for (let i = 1; i < Math.floor(LOOP_RULES.shardDays / 7); i++) week = weekBefore(week);
  return week;
}

type Tree = Record<string, unknown>;
const isObj = (v: unknown): v is Tree => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Add every numeric leaf of `from` into `into`, in place. */
export function addTree(into: Tree, from: unknown): Tree {
  if (!isObj(from)) return into;
  for (const [k, v] of Object.entries(from)) {
    if (typeof v === "number" && Number.isFinite(v)) into[k] = (typeof into[k] === "number" ? (into[k] as number) : 0) + v;
    else if (isObj(v)) addTree(isObj(into[k]) ? (into[k] as Tree) : (into[k] = {}), v);
  }
  return into;
}

/** A deep copy of a tree of plain data. */
const copy = (t: unknown): Tree => (isObj(t) ? (JSON.parse(JSON.stringify(t)) as Tree) : {});

const isLearningScope = (scope: string) => (IMAGE_STYLE_SCOPES as readonly string[]).includes(scope);

/**
 * What a week's counters add to each learning version's totals, keyed `<scope>|<v>`: the
 * `c.<scope>.<kind>.v<v>.<arm>.<signal>` leaves as `c.<kind>.<arm>.<signal>`.
 */
export function versionAdds(d: unknown): Map<string, Tree> {
  const out = new Map<string, Tree>();
  const c = isObj(d) && isObj(d.c) ? d.c : {};
  for (const [scope, byKind] of Object.entries(c)) {
    if (!isLearningScope(scope) || !isObj(byKind)) continue;
    for (const [kind, byV] of Object.entries(byKind)) {
      if (!isObj(byV)) continue;
      for (const [vKey, byArm] of Object.entries(byV)) {
        const m = /^v(\d{1,6})$/.exec(vKey);
        if (!m || !isObj(byArm)) continue;
        const key = `${scope}|${Number(m[1])}`;
        const into = out.get(key) ?? {};
        addTree(((into[kind] as Tree | undefined) ??= {}) as Tree, byArm);
        out.set(key, into);
      }
    }
  }
  return out;
}

export interface FoldDeps {
  db?: FirestoreLike;
  now?: Date;
}

export interface FoldResult {
  /** Weeks folded into `lt:` this visit (weeks with no counters only move the mark). */
  folded: number;
  /** Loop documents read. */
  reads: number;
  /** The week folded through after this visit, or null when nothing was due. */
  foldedThrough: string | null;
  /** Days since the oldest week not yet folded ended, before this visit; null when none was due. */
  behindDays: number | null;
}

/** Fold one week, in one regional transaction. False when it was already folded. */
async function foldWeek(ctx: TenantContext, week: string, db?: FirestoreLike): Promise<boolean> {
  return runLoopsTransaction(
    ctx,
    async (txn) => {
      const laneId = loopDayId.lane(ctx.tenantId);
      const shardIds = Array.from({ length: LOOP_RULES.shards }, (_, i) => loopDayId.week(ctx.tenantId, week, i));
      const [lane, ...shards] = await readLoopDaysTx(txn, ctx, [laneId, ...shardIds], db);
      const laneD = copy(lane?.d);
      if (typeof laneD.foldedThrough === "string" && laneD.foldedThrough >= week) return false;
      const sum: Tree = {};
      for (const s of shards) addTree(sum, s?.d);
      const adds = versionAdds(sum);
      const keys = [...adds.keys()];
      const lvIds = keys.map((k) => {
        const [scope, v] = k.split("|") as [string, string];
        return loopDayId.version(ctx.tenantId, scope, Number(v));
      });
      const lvs = lvIds.length ? await readLoopDaysTx(txn, ctx, lvIds, db) : [];
      // Writes, after every read.
      setLoopDayTx(txn, ctx, loopDayId.folded(ctx.tenantId, week), sum, { ttlAt: loopDayTtlAt("folded", week) }, db);
      keys.forEach((k, i) => {
        const d = copy(lvs[i]?.d);
        if (typeof d.throughWeek === "string" && d.throughWeek >= week) return;
        d.c = addTree(isObj(d.c) ? d.c : {}, adds.get(k));
        d.throughWeek = week;
        setLoopDayTx(txn, ctx, lvIds[i]!, d, {}, db);
      });
      setLoopDayTx(txn, ctx, laneId, { ...laneD, foldedThrough: week }, {}, db);
      return true;
    },
    db,
  );
}

/**
 * Fold the brand's closed weeks after `foldedThrough`, oldest first, at most FOLD_WEEKS_PER_VISIT
 * a visit. A brand never folded starts at the oldest week whose shards may still be kept. One
 * batched read finds which weeks have counters; a week with none only moves the mark.
 */
export async function foldClosedWeeks(ctx: TenantContext, foldedThrough: string | undefined, deps: FoldDeps = {}): Promise<FoldResult> {
  const now = deps.now ?? new Date();
  const lastClosed = lastClosedWeek(now);
  const oldest = oldestKeptWeek(now);
  if (foldedThrough && foldedThrough >= lastClosed) return { folded: 0, reads: 0, foldedThrough: null, behindDays: null };
  let first = foldedThrough ? weekAfter(foldedThrough) : oldest;
  // Shards older than their time to live are gone: there is nothing to fold before the oldest kept week.
  if (first < oldest) first = oldest;
  const behindDays = Math.max(0, Math.floor((now.getTime() - (isoWeekStart(first).getTime() + WEEK_MS)) / DAY_MS));
  const weeks: string[] = [];
  for (let w = first; w <= lastClosed && weeks.length < FOLD_WEEKS_PER_VISIT; w = weekAfter(w)) weeks.push(w);

  const ids = weeks.flatMap((w) => Array.from({ length: LOOP_RULES.shards }, (_, i) => loopDayId.week(ctx.tenantId, w, i)));
  const docs = await readLoopDays(ctx, ids, deps.db);
  let reads = ids.length;
  let folded = 0;
  let through: string | null = null;
  for (const [i, week] of weeks.entries()) {
    const has = docs.slice(i * LOOP_RULES.shards, (i + 1) * LOOP_RULES.shards).some(Boolean);
    if (has) {
      // The transaction reads the lane, the week's shards and the versions it adds to.
      reads += 1 + LOOP_RULES.shards;
      if (await foldWeek(ctx, week, deps.db)) folded += 1;
    }
    through = week;
  }
  // Weeks with no counters after the last one folded: only the mark moves.
  if (through) await mergeLaneState(ctx, { foldedThrough: through }, deps.db);
  return { folded, reads, foldedThrough: through, behindDays };
}
