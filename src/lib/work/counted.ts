import { forTenant, listAllTenants, organisationIdFor, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isIndexNotReady } from "@/lib/tenant/errors";
import { isoWeekStart, readBrandPointers } from "@/lib/tenant/loops";
import { usageThisMonth } from "@/lib/plans/meter";
import { isUsageMeterEnabled } from "@/lib/plans/flags";
import { isoWeekOf } from "@/lib/connectors/period";
import { isLoopsEnabled } from "@/lib/loops/flags";
import { roundTwo } from "@/lib/loops/fleetView";
import { LOOP_RULES } from "@/lib/loops/registry";
import { rowKindOf } from "@/lib/loops/stages";
import { usedAcrossBrands, USED_WEEKS_MAX, type UsedAsk } from "@/lib/loops/used";
import type { ResourceId } from "@/lib/plans/resources";
import type { Region } from "@/lib/types/tenant";
import { EVENT_TTL_MS } from "@/lib/connect/ingest";
import { partOf } from "./schedule";
import { purposeResource } from "./words";
import type { WorkBrand, WorkDeps } from "./scope";
import { SET_BY_MEASURE, type Counted, type CountedWeeks, type WorkTask } from "./types";

/**
 * The number on a due measure's check (ADR-0020), read once when the check first shows and kept on
 * it (`check.counted`). Work counts two things in v1:
 *
 * - A product event (Used): the brand's own events with that name, from Done (`from`) to the check
 *   (`to`), counted exactly by a Firestore count() through the product_events (tenantId,
 *   connectionId, event, receivedAt) index, with no row cap. Only while Firestore refuses that
 *   count because the index is missing or still building (just after a deploy) does Work read the
 *   newest 2,000 of the connection's events in that time through the index the Connected
 *   product's events list already has (tenantId, connectionId, receivedAt desc), and count those
 *   with the name: exact under 2,000, "at least N" at 2,000 (`capped`), back to the oldest row
 *   read (`backTo`).
 * - A purpose, a type or a LOOPS kind (Used, operators only), with LOOPS_ENABLED on: read from the
 *   learning loops' weekly counts across brands (usedAcrossBrands, step 5 of the learning loops,
 *   4.10 of the plan for steps 4 and 5), over the closed ISO weeks the check covers, never by
 *   walking brands. Those counts leave out the brands that opted out, and a week shows a number
 *   only from LOOP_RULES.cellOrgs organisations (loopsCountForCheck).
 * - A purpose with LOOPS_ENABLED off: the units the usage meter kept for it, per brand and per
 *   calendar month, over the months the check covers, and how many brands spent any, leaving out
 *   the brands that opted out of counts across brands (`fleetOptOut` on their `lb:` record). The
 *   brand count is kept only when those brands come from at least LOOP_RULES.cellOrgs
 *   organisations (`hidden` otherwise).
 *
 * With the meter off no purpose is counted. Counts only, never which brands. Anything else (a type
 * or a LOOPS kind with the loops off, none, Moves a number, Runs better) has no number yet: the
 * check says what Work can't count, and the person's read is the record (src/lib/work/words.ts).
 */

/** The most product events the fallback count reads, while the exact count's index isn't ready. */
export const COUNT_ROWS = 2000;

/** A product event's label in its connection's catalog, as the picker shows it; undefined for none. */
export type EventLabel = (connectionId: string, event: string) => string | undefined;

/** Labels from catalogs already read: each connection's events, by name. */
export function eventLabelOf(products: ReadonlyArray<{ id: string; events: ReadonlyArray<{ name: string; label: string }> }>): EventLabel {
  return (connectionId, event) => {
    const e = products.find((p) => p.id === connectionId)?.events.find((x) => x.name === event);
    return e && e.label && e.label !== e.name ? e.label : undefined;
  };
}

/** The task's measure check counts a product event: its line can name the event by its label. */
export function countsProductEvent(task: Pick<WorkTask, "measure" | "check">): boolean {
  const part = partOf(task.measure, task.check?.setBy === SET_BY_MEASURE ? (task.check.which ?? null) : null);
  return part !== null && part.kind === "used" && "productEvent" in part.counts;
}

/**
 * The catalog labels of the product events these brands' measures count, read once per brand (at
 * most 5), so a check reads as the picker does. A brand that can't be read keeps the raw names.
 */
export async function eventLabelsFor(brands: ReadonlyArray<WorkBrand>, deps: WorkDeps): Promise<EventLabel> {
  const unique = [...new Map(brands.map((b) => [b.id, b])).values()].slice(0, 5);
  const products: Array<{ id: string; events: Array<{ name: string; label: string }> }> = [];
  await Promise.all(
    unique.map(async (b) => {
      try {
        const rows = await forTenant({ tenantId: b.id, region: b.region, source: "system" }, regionDbOf(deps, b.region)).productConnections.find({ limit: 50 });
        for (const c of rows) products.push({ id: c.id, events: (c.catalog?.events ?? []).slice(0, 100).map((e) => ({ name: e.name, label: e.label ?? "" })) });
      } catch {
        // Unread: the raw event names.
      }
    }),
  );
  return eventLabelOf(products);
}

const regionDbOf = (deps: WorkDeps, region: Region): FirestoreLike | undefined => deps.regionDb?.(region);

export interface EventCountAsk {
  connectionId: string;
  event: string;
  /** From and to, as toISOString (receivedAt is kept the same way). */
  from: string;
  to: string;
}

/**
 * The exact count of a connection's events with one name between two times: a Firestore count()
 * through product_events (tenantId, connectionId, event, receivedAt), which productEventCount
 * tries first. `event` is set on track rows only, so identify rows never match. Firestore refuses
 * this query while that index is missing or building; the emulator and the fake serve it anyway,
 * so src/lib/work/indexes.test.ts guards that the index is there and serves this shape.
 */
export async function countProductEventsExact(ctx: TenantContext, ask: EventCountAsk, db?: FirestoreLike): Promise<number> {
  return forTenant(ctx, db).productEvents.count([
    ["connectionId", "==", ask.connectionId],
    ["event", "==", ask.event],
    ["receivedAt", ">=", ask.from],
    ["receivedAt", "<=", ask.to],
  ]);
}

/** The exact count's index, as the warning names it. */
const EXACT_INDEX = "product_events (tenantId, connectionId, event, receivedAt)";

/**
 * The count Work uses: the exact count, never capped. Only when Firestore refuses it because its
 * index is missing or still building does it log one warning and read the newest 2,000 events
 * instead (newestEventCount). Any other error is thrown as it is.
 */
export async function productEventCount(ctx: TenantContext, ask: EventCountAsk, db?: FirestoreLike): Promise<{ n: number; capped: boolean; backTo: string | null }> {
  try {
    return { n: await countProductEventsExact(ctx, ask, db), capped: false, backTo: null };
  } catch (err) {
    if (!isIndexNotReady(err)) throw err;
  }
  // Names the collection and the index only: no brand, connection or event name.
  console.warn(
    JSON.stringify({
      severity: "WARNING",
      message: `[work] the exact Used count's index isn't ready, so Work counts in the newest ${COUNT_ROWS} product events instead`,
      event: "work_count_index_not_ready",
      collection: "product_events",
      index: EXACT_INDEX,
    }),
  );
  return newestEventCount(ctx, ask, db);
}

/**
 * The fallback: the newest 2,000 of the connection's events between the two times, through the
 * existing (tenantId, connectionId, receivedAt desc) index, counted by name in memory.
 */
async function newestEventCount(ctx: TenantContext, ask: EventCountAsk, db?: FirestoreLike): Promise<{ n: number; capped: boolean; backTo: string | null }> {
  const rows = await forTenant(ctx, db).productEvents.find({
    where: [
      ["connectionId", "==", ask.connectionId],
      ["receivedAt", ">=", ask.from],
      ["receivedAt", "<=", ask.to],
    ],
    orderBy: [["receivedAt", "desc"]],
    limit: COUNT_ROWS,
  });
  const n = rows.filter((e) => e.type === "track" && e.event === ask.event).length;
  const capped = rows.length >= COUNT_ROWS;
  return { n, capped, backTo: capped ? (rows[rows.length - 1]?.receivedAt ?? null) : null };
}

/** Every calendar month (YYYY-MM, UTC) from one time to another, at most 13. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 13; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * The units every brand's meter kept for a purpose over the months, and how many brands spent
 * any: the brand count only when they come from at least LOOP_RULES.cellOrgs organisations. Null
 * with the meter off. One brand at a time, through forTenant, as the tick's all brand jobs read.
 * A brand that opted out of counts across brands (`fleetOptOut` on its `lb:` record, read through
 * the tenant layer) is left out, whichever switches are on now, so an opt out made while the
 * learning setting showed still holds after it goes.
 */
export async function purposeCount(purpose: string, months: readonly string[], deps: WorkDeps): Promise<{ units: number; brands: number | null } | null> {
  if (!isUsageMeterEnabled()) return null;
  const resource: ResourceId | null = purposeResource(purpose);
  if (!resource) return { units: 0, brands: 0 };
  const tenants = deps.controlDb ? await listAllTenants(deps.controlDb) : await listAllTenants();
  let units = 0;
  const brands = new Set<string>();
  const orgs = new Set<string>();
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    if ((await readBrandPointers(ctx, regionDbOf(deps, t.region))).fleetOptOut) continue;
    let spent = 0;
    for (const month of months) {
      const meters = await usageThisMonth({ tenantId: t.id, region: t.region }, { month, db: regionDbOf(deps, t.region) });
      spent += meters[resource]?.byPurpose?.[purpose] ?? 0;
    }
    if (spent > 0) {
      units += spent;
      brands.add(t.id);
      orgs.add(t.organisationId ?? organisationIdFor(t.id));
    }
  }
  return { units, brands: orgs.size >= LOOP_RULES.cellOrgs ? brands.size : null };
}

/**
 * What a due measure's check counted, to keep on it, or null when the measure has no number Work
 * can count (or the meter is off). From closedAt (or when the check was set) to the check's time,
 * or now when earlier. A product event's count reads only the events still kept when it runs (each
 * goes 90 days after it arrives), and it runs when the check first shows, which may be well after
 * it fell due: `backTo` says where it starts when that is after `from`, and `gone` says none of the
 * time is left to count. With LOOPS_ENABLED on, a purpose, a type or a LOOPS kind is counted from
 * the loops' weekly counts over the same time (loopsCountForCheck); with it off, a purpose walks
 * every brand's meter as Work v1 did (purposeCount).
 */
export async function countForCheck(task: WorkTask, brand: WorkBrand | undefined, deps: WorkDeps, now: Date): Promise<Counted | null> {
  const check = task.check;
  const part = partOf(task.measure, check?.which ?? null);
  if (!check || check.at === null || !part || part.kind !== "used") return null;
  const from = task.closedAt ?? check.setAt;
  const to = new Date(Math.min(Date.parse(check.at), now.getTime())).toISOString();
  const at = now.toISOString();
  const c = part.counts;
  if ("productEvent" in c) {
    if (!brand) return null;
    // Each event goes 90 days after it arrives, counted from now, not from the check's time: a
    // check first shown late, or moved on by Too soon to tell or Look again, counts back only as
    // far as events are still kept and says so (backTo), never "since" Done. With none of the time
    // left, it says the events are gone instead of a number.
    const kept = new Date(now.getTime() - EVENT_TTL_MS).toISOString();
    if (kept >= to) return { gone: true, from, to, at };
    const readFrom = from < kept ? kept : from;
    const r = await productEventCount(
      { tenantId: brand.id, region: brand.region, source: "system" },
      { connectionId: c.productEvent.connectionId, event: c.productEvent.event, from: readFrom, to },
      regionDbOf(deps, brand.region),
    );
    if (r.capped) return { n: r.n, capped: true, ...(r.backTo ? { backTo: r.backTo } : {}), from, to, at };
    return { n: r.n, ...(readFrom !== from ? { backTo: readFrom } : {}), from, to, at };
  }
  if ("purpose" in c || "type" in c || "loopKind" in c) {
    if (isLoopsEnabled()) {
      // Calls by purpose come from the usage meter, which keeps nothing while it is off.
      if ("purpose" in c && !isUsageMeterEnabled()) return null;
      return loopsCountForCheck(c, from, to, now, deps);
    }
    // With the loops off, a type or a LOOPS kind has no number yet, as in Work v1.
    if (!("purpose" in c)) return null;
    const months = monthsBetween(from, to);
    const r = await purposeCount(c.purpose, months, deps);
    if (!r) return null;
    const monthFrom = `${months[0]}-01T00:00:00.000Z`;
    const last = months[months.length - 1]!;
    const [y, m] = [Number(last.slice(0, 4)), Number(last.slice(5, 7))];
    const monthTo = new Date(Date.UTC(y, m, 1) - 1).toISOString();
    return { units: r.units, ...(r.brands === null ? { hidden: true } : { brands: r.brands }), from: monthFrom, to: monthTo, at };
  }
  return null;
}

const WEEK_MS = 7 * 86_400_000;

/** The Monday, at midnight UTC, of the ISO week a moment falls in, as the loops count weeks. */
const weekStartAt = (ms: number): number => isoWeekStart(isoWeekOf(new Date(ms).toISOString().slice(0, 10))).getTime();

/**
 * What a check counts from the learning loops' weekly counts across brands (LOOPS_ENABLED on):
 * the ISO weeks from the one `from` falls in to the one `to` falls in, of which only the closed
 * ones are read, the newest USED_WEEKS_MAX of them, by id through usedAcrossBrands, never by
 * walking brands. Those counts already leave out the brands that opted out. A week with counts
 * from fewer than LOOP_RULES.cellOrgs organisations shows no number, so `n` adds up the weeks that
 * show (rounded to 2 figures, as each week is), and `hidden` says none did. Weeks not over yet,
 * and closed weeks before the newest 13, are left out and said (CountedWeeks). With none of the
 * weeks closed it reads nothing and says so. Null only if the loops went off while it ran.
 */
export async function loopsCountForCheck(ask: UsedAsk, from: string, to: string, now: Date, deps: Pick<WorkDeps, "controlDb">): Promise<Counted | null> {
  const at = now.toISOString();
  const first = weekStartAt(Date.parse(from));
  const last = weekStartAt(Date.parse(to));
  // The newest closed week starts a week before the one now falls in.
  const closed = weekStartAt(now.getTime()) - WEEK_MS;
  const lastRead = Math.min(last, closed);
  const open = Math.max(0, Math.round((last - closed) / WEEK_MS));
  const closedWeeks = lastRead >= first ? Math.round((lastRead - first) / WEEK_MS) + 1 : 0;
  const read = Math.min(closedWeeks, USED_WEEKS_MAX);
  const row = "loopKind" in ask ? rowKindOf(ask.loopKind) : null;
  const said: Pick<CountedWeeks, "openFrom" | "row"> = {
    ...(open > 0 ? { openFrom: new Date(closed + WEEK_MS).toISOString() } : {}),
    ...("loopKind" in ask && row && row !== ask.loopKind ? { row } : {}),
  };
  if (read === 0) return { from, to, at, weeks: { read: 0, shown: 0, open, older: 0, ...said } };

  const firstRead = lastRead - (read - 1) * WEEK_MS;
  const ids = Array.from({ length: read }, (_, i) => isoWeekOf(new Date(firstRead + i * WEEK_MS).toISOString().slice(0, 10)));
  const answer = await usedAcrossBrands(ask, ids, { db: deps.controlDb });
  if ("off" in answer) return null;
  const shown = answer.weeks.filter((w) => w.count !== null);
  const older = closedWeeks - read;
  // The first week reaches back before Done only when it is the week Done fell in, and it says so only when it shows.
  const beforeDone = older === 0 && firstRead < Date.parse(from) && answer.weeks[0]?.count != null;
  const weeks: CountedWeeks = { read, shown: shown.length, open, older, ...(beforeDone ? { beforeDone: true } : {}), ...said };
  const span = { from: new Date(firstRead).toISOString(), to: new Date(lastRead + WEEK_MS - 1).toISOString(), at };
  if (!shown.length) return { hidden: true, ...span, weeks };
  const n = Math.round(roundTwo(shown.reduce((sum, w) => sum + (w.count ?? 0), 0)));
  const orgs = Math.min(...shown.map((w) => Math.round(w.orgs)));
  return { n, ...span, weeks: { ...weeks, orgs } };
}
