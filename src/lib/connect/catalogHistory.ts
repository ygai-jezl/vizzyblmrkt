import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type { CatalogRevision, CatalogRevisionSource } from "@/lib/types/catalogRevision";
import { describeChanges } from "./catalogChanges";

/**
 * Catalog history: every catalog change keeps the version it saved, so a
 * mistaken save can be seen and undone from the Catalog tab. Versions are
 * recorded whether or not the history UI is on (CATALOG_HISTORY_ENABLED), so
 * there's something to restore by the time it is. The last HISTORY_KEEP per
 * connection are kept.
 */

export const HISTORY_KEEP = 20;

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
      savedBy: ctx.email ?? ctx.userId ?? null,
      source: change.source,
      ...(change.restoredFrom !== undefined ? { restoredFrom: change.restoredFrom } : {}),
      changes: describeChanges(before.catalog, after.catalog).slice(0, 30),
    });
    const all = await col.find({ where: [["connectionId", "==", connectionId]], limit: 100 });
    const extra = all.sort((a, b) => b.rev - a.rev).slice(HISTORY_KEEP);
    await Promise.all(extra.map((r) => col.delete(r.id)));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.warn(`[connect] catalog history write failed for ${ctx.tenantId}/${connectionId}: ${m}`);
  }
}

/** A connection's kept versions, newest first. */
export async function listCatalogRevisions(ctx: TenantContext, connectionId: string, db?: FirestoreLike): Promise<CatalogRevision[]> {
  const rows = await forTenant(ctx, db).catalogRevisions.find({ where: [["connectionId", "==", connectionId]], limit: 100 });
  return rows.sort((a, b) => b.rev - a.rev).slice(0, HISTORY_KEEP);
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
