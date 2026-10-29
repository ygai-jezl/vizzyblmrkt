import { forTenant, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import { utcDayKey } from "@/lib/lifecycle/enrol";
import { loadPeopleConnections, syncPerson, syncProductLink, type PeopleConnections } from "./personSync";

/**
 * The lifecycle tick's part in keeping person records right (AUDIENCE_PERSON_LINKS_ENABLED).
 * Every tick it rebuilds the people a write path couldn't sync (`needsSync`). Once a day,
 * from PEOPLE_SWEEP_HOUR_UTC, it reads every product's people again, since a stage can
 * move with nothing written: New ends, Stuck and Quiet begin as the clocks pass.
 */

/** The daily check starts at this UTC hour, so stages are fresh before a European working day. */
export const PEOPLE_SWEEP_HOUR_UTC = 5;
const OWED_PAGE = 100;
/** Small pages, so a page started just before the deadline finishes soon after it. */
const PAGE = 50;

export interface PeopleSweepDeps {
  db?: FirestoreLike;
  now: () => number;
  deadlineMs: number;
  pageSize?: number;
}

export interface PeopleSweepResult {
  /** People owed a sync that got one. */
  synced: number;
  /** Product users read by today's check. */
  checked: number;
  failed: number;
}

function warn(what: string, ctx: TenantContext, err: unknown) {
  console.warn(`[audience] ${what} failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 200) : "error");
}

export async function sweepPeople(ctx: TenantContext, deps: PeopleSweepDeps): Promise<PeopleSweepResult> {
  const out: PeopleSweepResult = { synced: 0, checked: 0, failed: 0 };
  const repo = forTenant(ctx, deps.db);
  const connections = await loadPeopleConnections(ctx, deps.db);

  // People a write path owed a sync. Each is tried once a tick, so one that keeps failing can't hold up the rest.
  const tried = new Set<string>();
  while (deps.now() < deps.deadlineMs) {
    const owed = (await repo.contacts.find({ where: [["needsSync", "==", true]], limit: OWED_PAGE })).filter((c) => !tried.has(c.id));
    if (owed.length === 0) break;
    for (const c of owed) {
      if (deps.now() >= deps.deadlineMs) break;
      tried.add(c.id);
      try {
        await syncPerson(ctx, c.contactKey, { db: deps.db, nowMs: deps.now(), connections });
        out.synced += 1;
      } catch (err) {
        out.failed += 1;
        warn("owed person sync", ctx, err);
      }
    }
  }

  if (new Date(deps.now()).getUTCHours() < PEOPLE_SWEEP_HOUR_UTC) return out;
  const day = utcDayKey(deps.now());
  for (const connection of connections.values()) {
    if (deps.now() >= deps.deadlineMs) break;
    if (connection.personSweep?.day === day && connection.personSweep.status === "done") continue;
    const r = await sweepProduct(ctx, connection, connections, day, deps);
    out.checked += r.checked;
    out.failed += r.failed;
  }
  return out;
}

/** Today's check of one product's people, from where it left off. */
async function sweepProduct(
  ctx: TenantContext,
  connection: ProductConnection,
  connections: PeopleConnections,
  day: string,
  deps: PeopleSweepDeps,
): Promise<{ checked: number; failed: number }> {
  const repo = forTenant(ctx, deps.db);
  const pageSize = deps.pageSize ?? PAGE;
  const resumed = connection.personSweep?.day === day && connection.personSweep.status === "running" ? connection.personSweep : null;
  let cursor = resumed?.cursor ?? null;
  let checked = 0;
  let failed = 0;
  let finished = false;
  /** The people at the cursor's lastSeenAt this run has already read (the cursor is inclusive). */
  let atCursor = new Set<string>();
  while (deps.now() < deps.deadlineMs && !finished) {
    const where: WhereClause[] = [["connectionId", "==", connection.id], ...(cursor ? [["lastSeenAt", "<=", cursor] as WhereClause] : [])];
    const page = await repo.productUsers.find({ where, orderBy: [["lastSeenAt", "desc"]], limit: pageSize });
    for (const user of page) {
      if (atCursor.has(user.id) || user.status !== "active") continue;
      checked += 1;
      try {
        await syncProductLink(ctx, connection, user, { db: deps.db, nowMs: deps.now(), connections });
      } catch (err) {
        failed += 1;
        warn("person stage check", ctx, err);
      }
    }
    finished = page.length < pageSize;
    const last = page.at(-1)?.lastSeenAt ?? null;
    // Inclusive cursor: the page's last lastSeenAt is read again next time. Never stall on one value:
    // past a page of people sharing one, the rest wait for their next write or tomorrow's check.
    cursor = finished || !last ? null : last === cursor ? new Date(Date.parse(last) - 1).toISOString() : last;
    atCursor = new Set(page.filter((u) => u.lastSeenAt === cursor).map((u) => u.id));
    await repo.productConnections.update(connection.id, {
      personSweep: { day, status: finished ? "done" : "running", cursor, checked: (resumed?.checked ?? 0) + checked, updatedAt: new Date(deps.now()).toISOString() },
    });
  }
  return { checked, failed };
}
