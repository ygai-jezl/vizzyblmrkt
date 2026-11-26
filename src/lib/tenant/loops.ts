import { LOOP_RULES } from "@/lib/loops/registry";
import {
  BrandPointersSchema,
  ISO_WEEK_RE,
  LaneStateSchema,
  LOOP_DOC_PREFIXES,
  StampKeySchema,
  type BrandPointers,
  type CounterTree,
  type LaneState,
  type LoopDayDoc,
} from "@/lib/types/loopDay";
import { SCOPE_MAX_CHARS, SCOPE_RE } from "@/lib/types/loopStamp";
import { TenantIsolationError, TenantValidationError } from "./errors";
import { getDb } from "./firestore";
import { databaseIdForRegion } from "./region";
import { forTenant, TENANT_FIELD } from "./repository";
import type { DocRefLike, FirestoreLike, TenantContext, TransactionLike } from "./types";

/**
 * Tenant layer access for `loop_days` (regional, learning loops step 4): the loops' counts and
 * pointers per brand, with no words and no person (the six kinds are in src/lib/types/loopDay.ts).
 * Reads and counter writes go through `forTenant(ctx).loopDays`, which checks each document is
 * this brand's; the transaction that moves `lb:` with its version row reaches the collection here,
 * the only other place allowed to (ESLint exempts src/lib/tenant/**).
 *
 * Every id is built here from the server's tenant id, never from a request, and holds that id
 * whole between colons, so a brand's ids never reach another brand's documents.
 */
export const LOOP_DAYS = "loop_days" as const;

const DAY_MS = 86_400_000;

/** The tenant ids an id may hold: no colon or slash, so the id's parts stay apart. */
const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function tenantPart(tenantId: string): string {
  if (!TENANT_ID_RE.test(tenantId)) throw new TenantValidationError("loop_days needs a tenant id of letters, digits, underscores and hyphens only");
  return tenantId;
}

function weekPart(isoWeek: string): string {
  if (!ISO_WEEK_RE.test(isoWeek)) throw new TenantValidationError(`loop_days needs an ISO week such as 2026-W48, not ${isoWeek}`);
  return isoWeek;
}

/** The ids of a brand's loop documents (src/lib/types/loopDay.ts). */
export const loopDayId = {
  /** A week's counters, in one of LOOP_RULES.shards shards, numbered from 0. */
  week(tenantId: string, isoWeek: string, shard: number): string {
    if (!Number.isInteger(shard) || shard < 0 || shard >= LOOP_RULES.shards) throw new TenantValidationError(`loop_days has shards 0 to ${LOOP_RULES.shards - 1}`);
    return `${LOOP_DOC_PREFIXES.week}:${tenantPart(tenantId)}:${weekPart(isoWeek)}:${shard}`;
  },
  /** The week folded from its shards. */
  folded(tenantId: string, isoWeek: string): string {
    return `${LOOP_DOC_PREFIXES.folded}:${tenantPart(tenantId)}:${weekPart(isoWeek)}`;
  },
  /** One learned version's totals, for a scope whose line learns. */
  version(tenantId: string, scope: string, v: number): string {
    if (scope.length > SCOPE_MAX_CHARS || !SCOPE_RE.test(scope)) throw new TenantValidationError(`loop_days needs a scope such as image_style.natural_photo, not ${scope}`);
    if (!Number.isInteger(v) || v < 0) throw new TenantValidationError("loop_days needs a version of 0 or more");
    return `${LOOP_DOC_PREFIXES.version}:${tenantPart(tenantId)}:${scope}:${v}`;
  },
  /** Which version each scope uses, the pause and the opt out. */
  brand: (tenantId: string) => `${LOOP_DOC_PREFIXES.brand}:${tenantPart(tenantId)}`,
  /** The lane's own state. */
  lane: (tenantId: string) => `${LOOP_DOC_PREFIXES.lane}:${tenantPart(tenantId)}`,
  /** The stamp key. */
  key: (tenantId: string) => `${LOOP_DOC_PREFIXES.key}:${tenantPart(tenantId)}`,
};

/** The Monday an ISO week starts on, at midnight UTC. */
export function isoWeekStart(isoWeek: string): Date {
  const [year, week] = weekPart(isoWeek).split("-W").map(Number) as [number, number];
  // 4 January is always in week 1; step back to its Monday, then on by whole weeks.
  const jan4 = Date.UTC(year, 0, 4);
  const mondayOfWeek1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(mondayOfWeek1 + (week - 1) * 7 * DAY_MS);
}

/**
 * When a week's documents go, by the time to live policy on ttlAt: a week's shards
 * LOOP_RULES.shardDays after the week ends, its folded copy LOOP_RULES.foldedKeepDays after.
 * Readers never rely on it: they pick weeks by computed id.
 */
export function loopDayTtlAt(kind: "week" | "folded", isoWeek: string): Date {
  const weekEnds = isoWeekStart(isoWeek).getTime() + 7 * DAY_MS;
  return new Date(weekEnds + (kind === "week" ? LOOP_RULES.shardDays : LOOP_RULES.foldedKeepDays) * DAY_MS);
}

const regionalDb = (ctx: TenantContext, db?: FirestoreLike): FirestoreLike => db ?? (getDb(databaseIdForRegion(ctx.region)) as unknown as FirestoreLike);

/** An id must be one this brand's helpers built. */
function ownId(ctx: TenantContext, id: string): string {
  const parts = id.split(":");
  const prefixes: readonly string[] = Object.values(LOOP_DOC_PREFIXES);
  if (parts.length < 2 || !prefixes.includes(parts[0]!) || parts[1] !== tenantPart(ctx.tenantId)) {
    throw new TenantIsolationError(`${LOOP_DAYS}/${id} is not one of this brand's loop documents`);
  }
  return id;
}

/** Loop documents by id, each checked to be this brand's; a missing one is null. One read each, all at once. */
export async function readLoopDays(ctx: TenantContext, ids: readonly string[], db?: FirestoreLike): Promise<Array<LoopDayDoc | null>> {
  const repo = forTenant(ctx, db).loopDays;
  return Promise.all(ids.map((id) => repo.getById(ownId(ctx, id))));
}

/**
 * Add to a loop document's counters under `d`, in one merged write of increments: never a read
 * and never a transaction, so writers at once never wait on each other. The caller keeps it from
 * failing the work it counts (the meter's rule).
 */
export async function addToLoopDay(ctx: TenantContext, id: string, deltas: CounterTree, opts: { ttlAt?: Date } = {}, db?: FirestoreLike): Promise<void> {
  await forTenant(ctx, db).loopDays.increment(ownId(ctx, id), { d: deltas }, opts.ttlAt ? { ttlAt: opts.ttlAt } : {});
}

/** The brand's pointers (`lb:`), or none yet. */
export async function readBrandPointers(ctx: TenantContext, db?: FirestoreLike): Promise<BrandPointers> {
  const [doc] = await readLoopDays(ctx, [loopDayId.brand(ctx.tenantId)], db);
  return parsePointers(doc?.d);
}

function parsePointers(d: unknown): BrandPointers {
  const p = BrandPointersSchema.safeParse(d ?? {});
  return p.success ? p.data : BrandPointersSchema.parse({});
}

/** Run a transaction in the brand's regional database, where `lb:` and its version rows live. */
export function runLoopsTransaction<T>(ctx: TenantContext, fn: (txn: TransactionLike) => Promise<T>, db?: FirestoreLike): Promise<T> {
  return regionalDb(ctx, db).runTransaction(fn);
}

function brandRef(ctx: TenantContext, db?: FirestoreLike): DocRefLike {
  return regionalDb(ctx, db).collection(LOOP_DAYS).doc(loopDayId.brand(ctx.tenantId));
}

/** Inside runLoopsTransaction: the brand's pointers as they are now. */
export async function readBrandPointersTx(txn: TransactionLike, ctx: TenantContext, db?: FirestoreLike): Promise<BrandPointers> {
  const snap = await txn.get(brandRef(ctx, db));
  if (!snap.exists) return parsePointers(undefined);
  const data = snap.data() ?? {};
  if (data[TENANT_FIELD] !== ctx.tenantId) throw new TenantIsolationError(`${LOOP_DAYS}/${snap.id} is not this brand's`);
  return parsePointers(data.d);
}

/** Inside runLoopsTransaction, after its reads: replace the brand's pointers, in the same commit as the version row. */
export function writeBrandPointersTx(txn: TransactionLike, ctx: TenantContext, pointers: BrandPointers, db?: FirestoreLike): void {
  txn.set(brandRef(ctx, db), { [TENANT_FIELD]: ctx.tenantId, d: BrandPointersSchema.parse(pointers) });
}

/** The lane's own state (`ls:`), or none yet. */
export async function readLaneState(ctx: TenantContext, db?: FirestoreLike): Promise<LaneState> {
  const [doc] = await readLoopDays(ctx, [loopDayId.lane(ctx.tenantId)], db);
  const p = LaneStateSchema.safeParse(doc?.d ?? {});
  return p.success ? p.data : {};
}

/** Merge fields into the lane's own state, in one write with no read. */
export async function mergeLaneState(ctx: TenantContext, patch: LaneState, db?: FirestoreLike): Promise<void> {
  const d = LaneStateSchema.parse(patch);
  await regionalDb(ctx, db)
    .collection(LOOP_DAYS)
    .doc(loopDayId.lane(ctx.tenantId))
    .set({ [TENANT_FIELD]: ctx.tenantId, d }, { merge: true });
}

/**
 * The brand's stamp key (`lk:`): the stored one, or `fresh` stored with create() when there is
 * none. When two mint at once, the second create fails and it reads the first's key instead, so
 * a brand only ever has one. Only src/lib/loops/stamp.ts calls this.
 */
export async function stampKeyFor(ctx: TenantContext, fresh: () => string, db?: FirestoreLike): Promise<string> {
  const repo = forTenant(ctx, db).loopDays;
  const id = loopDayId.key(ctx.tenantId);
  const read = async () => {
    const doc = await repo.getById(id);
    const p = StampKeySchema.safeParse(doc?.d);
    return p.success ? p.data.key : null;
  };
  const stored = await read();
  if (stored) return stored;
  const key = StampKeySchema.parse({ key: fresh() }).key;
  try {
    await repo.create(id, { d: { key } });
    return key;
  } catch (err) {
    // Another mint won the race (create refuses an id that exists): use its key.
    if (!(err instanceof TenantIsolationError)) throw err;
    const theirs = await read();
    if (!theirs) throw err;
    return theirs;
  }
}
