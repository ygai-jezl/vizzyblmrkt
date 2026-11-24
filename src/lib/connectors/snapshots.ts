import { forTenant, type TenantContext } from "@/lib/tenant";
import { TenantIsolationError } from "@/lib/tenant/errors";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { MetricSnapshot, SnapshotBasis, SnapshotBy, SnapshotNote, SnapshotRow } from "@/lib/types/metricSnapshot";
import { snapshotId } from "./keys";
import { addDays, daysIn, todayIn } from "./period";

/**
 * The snapshot store (Connectors 2, ADR-0012): the only code that writes `metric_snapshots`, the
 * brand's collected numbers, through forTenant. Every write is a whole doc under a fixed id, so a
 * run that is repeated writes the same doc again; every read is by id, and erase reads by equality
 * on the connection, so no composite index is needed.
 *
 * A doc keeps at most 500 rows, ranked by the main measure, with the last kept row's numbers as its
 * floor when rows were cut: a row missing from a cut day is "at most the floor", never a zero. A key
 * longer than 500 characters is dropped and counted, and a doc that would pass 900 KB (Firestore
 * allows 1 MiB) loses rows from the bottom. Writing a day also deletes the day keepDays before it,
 * by id: the time to live is the backstop, set TTL_MARGIN_DAYS later than that, so a day still in
 * the keep window (which ends on the last collected day, days behind today) is never past it.
 */

/** Rows kept per doc (decision 35). */
export const KEEP_ROWS = 500;
/** A row key longer than this is dropped and counted, never cut short. */
export const MAX_KEY_LENGTH = 500;
/** A doc stays under this many bytes of JSON. */
export const MAX_DOC_BYTES = 900_000;
/** Day docs read at once, so a long read never holds many 60 KB docs at the same time. */
const READ_BATCH = 10;
/** Docs deleted per page when erasing, for the same reason. */
const ERASE_PAGE = 25;

/** The measures rows are ranked by, most important first: the first one a row has that differs. */
export const RANK_ORDER = ["searchClicks", "searchImpressions", "ga4Views", "ga4Sessions", "ga4KeyEvents", "cfRequests", "cfPageViews"] as const;

/** Most important first, then by key and host, so a cut is the same every time. */
export function compareRows(a: SnapshotRow, b: SnapshotRow): number {
  for (const k of RANK_ORDER) {
    const d = (b.m[k] ?? 0) - (a.m[k] ?? 0);
    if (d) return d;
  }
  return a.key.localeCompare(b.key) || (a.host ?? "").localeCompare(b.host ?? "");
}

/** The rows to keep: ranked, long keys dropped, at most `keep`, with the floor when any were cut. */
export function cutRows(
  rows: readonly SnapshotRow[],
  keep = KEEP_ROWS,
): { rows: SnapshotRow[]; rowsSeen: number; rowsDropped: number; floor: Record<string, number> | null } {
  const fit = rows.filter((r) => r.key.length <= MAX_KEY_LENGTH);
  const ranked = [...fit].sort(compareRows);
  const kept = ranked.slice(0, keep);
  const dropped = rows.length - kept.length;
  return { rows: kept, rowsSeen: rows.length, rowsDropped: dropped, floor: ranked.length > kept.length && kept.length ? { ...kept.at(-1)!.m } : null };
}

/** The doc's size as JSON, roughly what Firestore stores. */
const sizeOf = (doc: Omit<MetricSnapshot, "id">) => Buffer.byteLength(JSON.stringify(doc), "utf8");

/** Rows dropped from the bottom until the doc fits, the floor moving up with them. */
export function fitDoc(doc: Omit<MetricSnapshot, "id">): Omit<MetricSnapshot, "id"> {
  if (sizeOf(doc) <= MAX_DOC_BYTES) return doc;
  const rows = [...doc.rows];
  let out = doc;
  while (rows.length && sizeOf(out) > MAX_DOC_BYTES) {
    rows.splice(rows.length > 1 ? Math.floor(rows.length * 0.9) : 0);
    out = { ...doc, rows: [...rows], rowsDropped: doc.rowsDropped + (doc.rows.length - rows.length), floor: rows.length ? { ...rows.at(-1)!.m } : doc.floor };
  }
  return out;
}

/**
 * Days the time to live waits past the keep window. The window is counted back from the last
 * collected day, which trails today by the provider's lag (Search Console about 3 Pacific days), so
 * a time to live of the day plus keepDays would let Firestore delete the window's oldest days while
 * they are still in it. Longer than any lag, so the time to live stays a backstop.
 */
export const TTL_MARGIN_DAYS = 7;

/** Midnight UTC of a day plus keepDays and the margin, as a Date: the time to live. */
export const ttlFor = (lastDay: string, keepDays: number): Date => new Date(`${addDays(lastDay, keepDays + TTL_MARGIN_DAYS)}T00:00:00.000Z`);

/**
 * The oldest day whose doc can still be there at `now`: older ones are past their time to live,
 * whatever the cursor says (a connection that stopped collecting weeks ago).
 */
export function oldestAlive(now: Date, keepDays: number): string {
  return addDays(todayIn(now, "UTC"), -(keepDays + TTL_MARGIN_DAYS - 1));
}

/** What a connection's snapshots carry about it. */
export interface SnapshotOwner {
  id: string;
  connectorId: string;
  account: string;
  gen: number;
}

export interface DayDocInput {
  owner: SnapshotOwner;
  stream: string;
  by: SnapshotBy;
  day: string;
  timeZone: string | null;
  final: boolean;
  totals: Record<string, number | null> | null;
  rows: SnapshotRow[];
  /** The provider had more rows than it sent. */
  more: boolean;
  basis?: SnapshotBasis | null;
  notes?: SnapshotNote[];
  keepDays: number;
}

export interface StoreDeps {
  db?: FirestoreLike;
  now?: Date;
}

const repoOf = (ctx: TenantContext, deps: StoreDeps) => forTenant(ctx, deps.db).metricSnapshots;

/** Write a whole doc under its id, replacing what was there (the tenant is stamped from ctx). */
export async function putSnapshot(ctx: TenantContext, id: string, doc: Omit<MetricSnapshot, "id" | "tenantId">, deps: StoreDeps = {}): Promise<void> {
  const whole = { ...doc } as Omit<MetricSnapshot, "id" | "tenantId">;
  await repoOf(ctx, deps).upsert(
    id,
    () => whole,
    () => whole,
  );
}

/** Build a day doc: rows cut to 500 with their floor, then fitted to size. */
export function dayDoc(input: DayDocInput, collectedAt: string): Omit<MetricSnapshot, "id" | "tenantId"> {
  const cut = cutRows(input.rows);
  const doc = fitDoc({
    tenantId: "",
    connectionId: input.owner.id,
    gen: input.owner.gen,
    account: input.owner.account,
    connectorId: input.owner.connectorId,
    stream: input.stream,
    by: input.by,
    day: input.day,
    window: null,
    days: null,
    timeZone: input.timeZone,
    final: input.final,
    totals: input.totals,
    rows: cut.rows,
    rowsSeen: cut.rowsSeen,
    rowsDropped: cut.rowsDropped,
    more: input.more,
    floor: cut.floor,
    basis: input.basis ?? null,
    notes: input.notes ?? [],
    collectedAt,
    ttlAt: ttlFor(input.day, input.keepDays),
  });
  const { tenantId: _t, ...rest } = doc;
  return rest;
}

/** Write one day's doc for one grouping. Returns its id and what was kept. */
export async function writeDayDoc(ctx: TenantContext, input: DayDocInput, deps: StoreDeps = {}): Promise<{ id: string; kept: number; dropped: number; seen: number }> {
  const id = snapshotId(input.owner.id, input.owner.gen, input.stream, input.by, input.day);
  const doc = dayDoc(input, (deps.now ?? new Date()).toISOString());
  await putSnapshot(ctx, id, doc, deps);
  return { id, kept: doc.rows.length, dropped: doc.rowsDropped, seen: doc.rowsSeen };
}

/** Delete one doc by id, if this brand has it. */
export async function deleteSnapshot(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<boolean> {
  try {
    await repoOf(ctx, deps).delete(id);
    return true;
  } catch (err) {
    if (err instanceof TenantIsolationError) return false;
    throw err;
  }
}

/** The day keepDays before `day` leaves, by id, for each grouping: called when a newer day lands. */
export async function dropAgedDay(ctx: TenantContext, owner: SnapshotOwner, stream: string, by: readonly SnapshotBy[], day: string, keepDays: number, deps: StoreDeps = {}): Promise<number> {
  const old = addDays(day, -keepDays);
  const gone = await Promise.all(by.map((b) => deleteSnapshot(ctx, snapshotId(owner.id, owner.gen, stream, b, old), deps)));
  return gone.filter(Boolean).length;
}

/** One doc by id, or null. */
export async function readSnapshot(ctx: TenantContext, id: string, deps: StoreDeps = {}): Promise<MetricSnapshot | null> {
  return repoOf(ctx, deps).getById(id);
}

/**
 * A grouping's day docs from `from` to `to`, read by id a few at a time, by day. A day with no doc
 * (not collected yet, or gone) is simply absent. `each` sees every doc as it is read, so a caller
 * that adds them up never holds them all.
 */
export async function readDayDocs(
  ctx: TenantContext,
  owner: Pick<SnapshotOwner, "id" | "gen">,
  stream: string,
  by: SnapshotBy,
  from: string,
  to: string,
  deps: StoreDeps & { each?: (doc: MetricSnapshot) => void } = {},
): Promise<Map<string, MetricSnapshot>> {
  const out = new Map<string, MetricSnapshot>();
  if (from > to) return out;
  const days = Array.from({ length: daysIn(from, to) }, (_, i) => addDays(from, i));
  for (let i = 0; i < days.length; i += READ_BATCH) {
    const batch = days.slice(i, i + READ_BATCH);
    const docs = await Promise.all(batch.map((d) => readSnapshot(ctx, snapshotId(owner.id, owner.gen, stream, by, d), deps)));
    docs.forEach((doc, j) => {
      if (!doc) return;
      if (deps.each) deps.each(doc);
      else out.set(batch[j]!, doc);
    });
  }
  return out;
}

/**
 * Delete a connection's snapshots: every one ("all", on Disconnect and the purge), or those of the
 * listed old generations (Change property). Equality only, a few docs a page. Returns how many.
 */
export async function eraseSnapshots(ctx: TenantContext, connectionId: string, gens: "all" | readonly number[], deps: StoreDeps = {}): Promise<number> {
  const repo = repoOf(ctx, deps);
  if (gens === "all") return repo.deleteWhere([["connectionId", "==", connectionId]], { pageSize: ERASE_PAGE });
  let n = 0;
  for (const g of [...new Set(gens)]) {
    n += await repo.deleteWhere(
      [
        ["connectionId", "==", connectionId],
        ["gen", "==", g],
      ],
      { pageSize: ERASE_PAGE },
    );
  }
  return n;
}

/** How many snapshots a connection has (the purge's dry run). */
export async function countSnapshots(ctx: TenantContext, connectionId: string, deps: StoreDeps = {}): Promise<number> {
  return repoOf(ctx, deps).count([["connectionId", "==", connectionId]]);
}
