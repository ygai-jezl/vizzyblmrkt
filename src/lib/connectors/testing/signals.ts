import { createDataConnection, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { freshCollect, type ConnectionGrant } from "@/lib/types/dataConnection";
import type { SnapshotRow } from "@/lib/types/metricSnapshot";
import { healthyAt } from "../health";
import { planningId } from "../keys";
import { addDays } from "../period";
import { putSnapshot, ttlFor, writeDayDoc } from "../snapshots";

/**
 * Fixtures for suggestions from collected numbers (Connectors 2 group 4): a Search Console
 * connection with 90 collected days to 20 Nov, and its day docs and planning docs, all made up for
 * made-up sites (fernhill.example). No provider is ever called.
 */

export const LAST_DAY = "2026-11-20";
export const SC_STREAM = "search_performance";
export const PLANNING: ConnectionGrant[] = [
  { to: "members", can: "read" },
  { to: "agent:vizzy", can: "read" },
];

/** A connected Search Console site, collected to 20 Nov with 90 days kept. */
export async function seedSearchConsole(ctx: TenantContext, db: FirestoreLike, id: string, over: Partial<NewDataConnection> = {}): Promise<void> {
  const at = "2026-08-20T10:00:00.000Z";
  await createDataConnection(
    ctx,
    {
      id,
      connectorId: "search-console",
      method: "share_access",
      label: "Google Search Console",
      account: "sc-domain:fernhill.example",
      ownerUid: "usr_admin",
      grants: PLANNING,
      secrets: {},
      health: healthyAt(new Date(at)),
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: at,
      updatedAt: at,
      disconnectedAt: null,
      collect: { ...freshCollect(null, 0), lastDay: LAST_DAY, finalThrough: LAST_DAY, backfilledTo: addDays(LAST_DAY, -89), filled: true, timeZone: "America/Los_Angeles", rolledOn: "2026-11-23" },
      ...over,
    },
    [{ kind: "connected", by: "usr_admin", at }],
    db,
  );
}

const owner = (id: string, account = "sc-domain:fernhill.example", gen = 0) => ({ id, connectorId: "search-console", account, gen });

/**
 * Day docs for one grouping, `days` of them to the last day, each day's rows from `rowsOn`. A day
 * listed in `cut` keeps its rows but says some were cut, with `floor` as its last kept row.
 */
export async function writeDays(
  ctx: TenantContext,
  db: FirestoreLike,
  id: string,
  by: "page" | "topic",
  days: number,
  rowsOn: (day: string, i: number) => SnapshotRow[],
  opts: { cut?: Set<string>; floor?: Record<string, number>; last?: string; gen?: number } = {},
): Promise<string[]> {
  const last = opts.last ?? LAST_DAY;
  const list = Array.from({ length: days }, (_, i) => addDays(last, i - days + 1));
  for (const [i, day] of list.entries()) {
    const rows = rowsOn(day, i);
    const cut = opts.cut?.has(day) ?? false;
    // A cut day: one more row than kept, below the floor, so the store records the cut and floor.
    const extra: SnapshotRow[] = cut ? Array.from({ length: 500 }, (_, k) => ({ key: `/filler-${k}`, host: "fernhill.example", m: { searchClicks: opts.floor?.searchClicks ?? 1, searchImpressions: opts.floor?.searchImpressions ?? 1 } })) : [];
    await writeDayDoc(ctx, { owner: owner(id, undefined, opts.gen), stream: SC_STREAM, by, day, timeZone: "America/Los_Angeles", final: true, totals: null, rows: [...rows, ...extra], more: false, keepDays: 90 }, { db, now: new Date("2026-11-23T09:00:00.000Z") });
  }
  return list;
}

/** A search row for a topic day doc. */
export const search = (words: string, impressions: number, clicks = 0, position = 9): SnapshotRow => ({ key: words, m: { searchImpressions: impressions, searchClicks: clicks, searchPosition: position } });
/** A page row for a page day doc. */
export const page = (path: string, clicks: number, impressions = clicks * 20, host = "fernhill.example"): SnapshotRow => ({ key: path, host, m: { searchClicks: clicks, searchImpressions: impressions } });

/** A planning doc (questions or subjects) over the 28 days to the last day. */
export async function writePlanning(ctx: TenantContext, db: FirestoreLike, id: string, by: "question" | "subject", rows: SnapshotRow[], opts: { last?: string; gen?: number; account?: string } = {}): Promise<void> {
  const last = opts.last ?? LAST_DAY;
  const gen = opts.gen ?? 0;
  await putSnapshot(
    ctx,
    planningId(id, gen, SC_STREAM, by),
    {
      connectionId: id,
      gen,
      account: opts.account ?? "sc-domain:fernhill.example",
      connectorId: "search-console",
      stream: SC_STREAM,
      by,
      day: null,
      window: { from: addDays(last, -27), to: last },
      days: 28,
      timeZone: "America/Los_Angeles",
      final: true,
      totals: null,
      rows,
      rowsSeen: rows.length,
      rowsDropped: 0,
      more: false,
      floor: null,
      basis: null,
      notes: [],
      collectedAt: "2026-11-23T09:00:00.000Z",
      ttlAt: ttlFor(last, 90),
    },
    { db },
  );
}
