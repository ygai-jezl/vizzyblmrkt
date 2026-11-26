import { forTenant, listAllTenants, organisationIdFor, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { usageThisMonth } from "@/lib/plans/meter";
import { isUsageMeterEnabled } from "@/lib/plans/flags";
import { LOOP_RULES } from "@/lib/loops/registry";
import type { ResourceId } from "@/lib/plans/resources";
import type { Region } from "@/lib/types/tenant";
import { partOf } from "./schedule";
import { purposeResource } from "./words";
import type { WorkBrand, WorkDeps } from "./scope";
import type { Counted, WorkTask } from "./types";

/**
 * The number on a due measure's check (ADR-0018), read once when the check first shows and kept on
 * it (`check.counted`). Work counts two things in v1:
 *
 * - A product event (Used): the brand's own events with that name, from Done (`from`) to the check
 *   (`to`). The exact count needs a product_events (tenantId, connectionId, event, receivedAt)
 *   index that isn't approved yet, so Work reads the newest 2,000 of the connection's events in
 *   that time through the index the Connected product's events list already has (tenantId,
 *   connectionId, receivedAt desc), and counts those with the name. With fewer than 2,000 the
 *   count is exact; at 2,000 it is "at least N" (`capped`), back to the oldest row read
 *   (`backTo`). countProductEventsExact below is the exact count, kept apart and wired nowhere:
 *   once the index is approved and deployed, productEventCount calls it instead.
 * - A purpose (Used, operators only): the units the usage meter kept for it, per brand and per
 *   calendar month, over the months the check covers, and how many brands spent any. The brand
 *   count is kept only when those brands come from at least LOOP_RULES.cellOrgs organisations
 *   (`hidden` otherwise). With the meter off nothing is counted. Counts only, never which brands.
 *
 * Anything else (a type, a LOOPS kind, none, Moves a number, Runs better) has no number yet: the
 * check says what Work can't count, and the person's read is the record (src/lib/work/words.ts).
 */

/** The most product events one count reads. */
export const COUNT_ROWS = 2000;

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
 * through product_events (tenantId, connectionId, event, receivedAt). NOT WIRED: that index isn't
 * approved, and Firestore refuses this query without it (the emulator and the fake serve it, so
 * only src/lib/work/indexes.test.ts guards it). Turning it on is adding the index and calling this
 * from productEventCount.
 */
export async function countProductEventsExact(ctx: TenantContext, ask: EventCountAsk, db?: FirestoreLike): Promise<number> {
  return forTenant(ctx, db).productEvents.count([
    ["connectionId", "==", ask.connectionId],
    ["event", "==", ask.event],
    ["receivedAt", ">=", ask.from],
    ["receivedAt", "<=", ask.to],
  ]);
}

/**
 * The count Work uses now: the newest 2,000 of the connection's events between the two times,
 * through the existing (tenantId, connectionId, receivedAt desc) index, counted by name in memory.
 */
export async function productEventCount(ctx: TenantContext, ask: EventCountAsk, db?: FirestoreLike): Promise<{ n: number; capped: boolean; backTo: string | null }> {
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
 * or now when earlier.
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
    const r = await productEventCount(
      { tenantId: brand.id, region: brand.region, source: "system" },
      { connectionId: c.productEvent.connectionId, event: c.productEvent.event, from, to },
      regionDbOf(deps, brand.region),
    );
    return { n: r.n, ...(r.capped ? { capped: true, ...(r.backTo ? { backTo: r.backTo } : {}) } : {}), from, to, at };
  }
  if ("purpose" in c) {
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
