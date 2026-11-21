import { forTenant, type TenantContext, type WhereClause } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type { CatalogRevision, CatalogRevisionSource } from "@/lib/types/catalogRevision";
import { describeChanges } from "./catalogChanges";

/**
 * Catalog history: every catalog change keeps the version it saved, so a
 * mistaken save can be seen and undone from the Catalog tab. Versions are
 * recorded whether or not the history UI is on (CATALOG_HISTORY_ENABLED), so
 * there's something to restore by the time it is. Every version is kept, with
 * no limit (settings history on every plan), and who saved it is kept as a user
 * id only: the name is looked up when shown.
 */

/** Versions per page of the history when the caller doesn't say. */
export const CATALOG_HISTORY_PAGE = 20;
const MAX_PAGE = 100;

/** `pcn_…_r000012`: one per connection and version, so a retried write can't duplicate it. */
export function revisionId(connectionId: string, rev: number): string {
  return `${connectionId}_r${String(rev).padStart(6, "0")}`;
}

export interface CatalogChange {
  connectionId: string;
  /** The catalog it replaced: its version, and when that was saved. */
  before: { catalog: ConnectionCatalog; rev: number; savedAt: string };
  after: { catalog: ConnectionCatalog; rev: number };
  source: Exclude<CatalogRevisionSource, "before_history">;
  restoredFrom?: number;
  nowIso: string;
}

/**
 * Record a change that's already committed. Best effort: a failure is logged,
 * never surfaced — the save itself succeeded.
 */
export async function recordCatalogRevision(ctx: TenantContext, change: CatalogChange, db?: FirestoreLike): Promise<void> {
  const col = forTenant(ctx, db).catalogRevisions;
  const { connectionId, before, after } = change;
  try {
    // The first change since history began: keep what it replaced, so that can be restored too.
    const prevId = revisionId(connectionId, before.rev);
    if (!(await col.getById(prevId))) {
      await col
        .create(prevId, {
          connectionId,
          rev: before.rev,
          catalog: before.catalog,
          savedAt: before.savedAt,
          savedBy: null,
          source: "before_history",
          changes: [],
        })
        .catch(() => {}); // already recorded by a racing save
    }
    await col.create(revisionId(connectionId, after.rev), {
      connectionId,
      rev: after.rev,
      catalog: after.catalog,
      savedAt: change.nowIso,
      // A user id only, never an address: the name is looked up when the history is shown.
      savedBy: ctx.userId ?? null,
      source: change.source,
      ...(change.restoredFrom !== undefined ? { restoredFrom: change.restoredFrom } : {}),
      changes: describeChanges(before.catalog, after.catalog).slice(0, 30),
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.warn(`[connect] catalog history write failed for ${ctx.tenantId}/${connectionId}: ${m}`);
  }
}

/**
 * A connection's versions, newest first, a page at a time: pass `nextCursor` back as `cursor`.
 * Reads by (tenantId, connectionId, rev DESC). Until that index is ready (just after a deploy) it
 * falls back to the query history used before, newest first in memory, which then held at most
 * 20 versions per connection.
 */
export async function listCatalogRevisions(
  ctx: TenantContext,
  connectionId: string,
  opts: { cursor?: number | null; limit?: number } = {},
  db?: FirestoreLike,
): Promise<{ versions: CatalogRevision[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? CATALOG_HISTORY_PAGE)), MAX_PAGE);
  const col = forTenant(ctx, db).catalogRevisions;
  const where: WhereClause[] = [["connectionId", "==", connectionId]];
  let rows: CatalogRevision[];
  try {
    rows = await col.find({ where, orderBy: [["rev", "desc"]], ...(opts.cursor != null ? { startAfter: [opts.cursor] } : {}), limit: limit + 1 });
  } catch (err) {
    console.warn(`[connect] catalog history read by rev failed (index building?) for ${ctx.tenantId}/${connectionId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    const all = await col.find({ where, limit: 100 });
    rows = all
      .sort((a, b) => b.rev - a.rev)
      .filter((r) => opts.cursor == null || r.rev < opts.cursor)
      .slice(0, limit + 1);
  }
  const versions = rows.slice(0, limit);
  return { versions, nextCursor: rows.length > limit ? versions[versions.length - 1]!.rev : null };
}

export async function getCatalogRevision(
  ctx: TenantContext,
  connectionId: string,
  rev: number,
  db?: FirestoreLike,
): Promise<CatalogRevision | null> {
  const r = await forTenant(ctx, db).catalogRevisions.getById(revisionId(connectionId, rev));
  return r && r.connectionId === connectionId ? r : null;
}
