import { removeFromIndex } from "@/lib/search/indexer";
import type { SearchStore } from "@/lib/search/types";
import { changeDataConnection, forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { CollectState, DataConnection } from "@/lib/types/dataConnection";
import { searchTextRef } from "./keys";
import { searchConsoleManifest } from "./manifests/searchConsole";
import { declineAs } from "./signals/reconcile";
import { eraseSignals, signalsOfConnection } from "./signals/store";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { isAgentActionId } from "@/lib/types/agentAction";
import { eraseSnapshots } from "./snapshots";

/**
 * Erasing what came from a connection (Connectors 2, ADR-0012), in the style of
 * src/lib/connect/erase.ts: idempotent, equality only, whatever any switch says.
 *
 * - Disconnect sets `collect.erasePending` to "all" in the change that disconnects, then erases
 *   after it is saved.
 * - Change property bumps the generation and sets the old one pending in the same change, then
 *   erases that generation only, so the new site's numbers are never touched.
 * - The operator purge erases everything, with every switch off.
 * - The lane retries any connection whose erase is still pending, whenever CONNECTORS_ENABLED is
 *   on (a crash or a timeout between the save and the erase).
 *
 * What goes: the connection's metric snapshots (every day, rolled and planning doc); its
 * data_signals rows (group 4), after their open suggestions are declined as stale with their
 * values cleared; and a Search Console connection's searches in brand search (ADR-0013), removed
 * with indexing forced on, so they leave whatever SEARCH_INDEX_ENABLED or
 * CONNECTORS_SEARCH_TEXT_ENABLED says; a failed removal leaves the erase pending for the lane. Each
 * erase records one `erased` activity row, kept in the log only, never on the record's recent list.
 */

/** The brand's search index (tests pass an in-memory one); default searchStoreFor. */
export type SearchIndexOf = (ctx: Pick<TenantContext, "tenantId" | "region">) => SearchStore;

export interface EraseCounts {
  snapshots: number;
  /** Its data_signals rows deleted, and its open suggestions declined as stale. */
  signals: number;
  declined: number;
  /**
   * Its searches in brand search: removed (or none were there), failed (the erase stays pending),
   * or skipped for a connection that puts none there.
   */
  search: "removed" | "failed" | "skipped";
}

/**
 * Remove a connection's searches from brand search, whatever any switch says. Only Search Console
 * connections put any there; one that can't be read is tried anyway, so nothing is left behind.
 */
async function eraseSearchText(ctx: TenantContext, connectionId: string, deps: { db?: FirestoreLike; searchIndex?: SearchIndexOf }): Promise<EraseCounts["search"]> {
  const conn = await forTenant(ctx, deps.db)
    .dataConnections.getById(connectionId)
    .catch(() => null);
  if (conn && conn.connectorId !== searchConsoleManifest.id) return "skipped";
  const outcome = await removeFromIndex(ctx, "research", searchTextRef(connectionId), { force: true, ...(deps.searchIndex ? { store: deps.searchIndex(ctx) } : {}) });
  return outcome === "failed" ? "failed" : "removed";
}

/**
 * A connection's suggestions from collected numbers, whatever any switch says: the open one each
 * of its rows names declined as stale with its values cleared, then the rows deleted. For listed
 * generations, only theirs. A row outlives its suggestion (it is refreshed while its rule holds,
 * and its suggestion expires 30 days after it was proposed), so the rows find every open one, by
 * equality on the connection and then by id.
 */
async function eraseSuggestions(
  ctx: TenantContext,
  connectionId: string,
  gens: "all" | readonly number[],
  deps: { db?: FirestoreLike; now?: Date },
): Promise<{ signals: number; declined: number }> {
  const rows = (await signalsOfConnection(ctx, connectionId, deps)).filter((r) => gens === "all" || gens.includes(r.gen));
  let declined = 0;
  for (const id of new Set(rows.map((r) => r.agentActionId))) {
    if (!isAgentActionId(id)) continue;
    const a = await getAgentAction(ctx, id, deps);
    if (a && (a.state === "proposed" || a.state === "approved") && (await declineAs(ctx, a, "stale", deps))) declined += 1;
  }
  const signals = await eraseSignals(ctx, connectionId, gens, deps);
  return { signals, declined };
}

/** What is still to erase after erasing `done`: nothing, or the generations left. */
export function pendingAfter(pending: CollectState["erasePending"], done: "all" | readonly number[]): CollectState["erasePending"] {
  if (pending === null || done === "all") return null;
  if (pending === "all") return "all";
  const left = pending.filter((g) => !done.includes(g));
  return left.length ? left : null;
}

/** Pending erases joined: "all" wins; else every generation listed once. */
export function pendingWith(pending: CollectState["erasePending"], add: "all" | readonly number[]): CollectState["erasePending"] {
  if (pending === "all" || add === "all") return "all";
  return [...new Set([...(pending ?? []), ...add])].sort((a, b) => a - b);
}

/**
 * Erase a connection's collected rows: all of them, or the listed old generations, and its searches
 * in brand search either way (they are the old site's after Change property; the new site's are
 * indexed again once it has 28 days). Then, in one change, clear what is pending (only what this
 * erase covered) and record one `erased` row (the purge, which leaves its own "purged" row, records
 * none). When the searches couldn't be removed, nothing is cleared, so the lane tries again. Safe to
 * run again: a second run finds nothing to delete.
 */
export async function eraseConnectionData(
  ctx: TenantContext,
  connectionId: string,
  gens: "all" | readonly number[],
  opts: { by: string; now?: Date; db?: FirestoreLike; record?: boolean; searchIndex?: SearchIndexOf },
): Promise<EraseCounts> {
  const snapshots = await eraseSnapshots(ctx, connectionId, gens, { db: opts.db });
  const { signals, declined } = await eraseSuggestions(ctx, connectionId, gens, { db: opts.db, now: opts.now });
  const search = await eraseSearchText(ctx, connectionId, opts);
  if (search === "failed") return { snapshots, signals, declined, search };
  const at = (opts.now ?? new Date()).toISOString();
  const record = opts.record !== false;
  await changeDataConnection(
    ctx,
    connectionId,
    (cur) => {
      const patch = cur.collect?.erasePending ? { collect: { ...cur.collect, erasePending: pendingAfter(cur.collect.erasePending, gens) } } : {};
      if (!record && !("collect" in patch)) return null;
      return { patch, activity: record ? [{ kind: "erased", by: opts.by, at, code: gens === "all" ? "all" : "old_site", recent: false }] : [] };
    },
    opts.db,
  );
  return { snapshots, signals, declined, search };
}

/**
 * The lane's housekeeping: erase what a connection still has pending, one connection at a time.
 * A failure is logged and left pending for the next run.
 */
export async function retryPendingErases(
  ctx: TenantContext,
  connections: readonly DataConnection[],
  deps: { db?: FirestoreLike; now?: Date; searchIndex?: SearchIndexOf } = {},
): Promise<{ erased: number }> {
  let erased = 0;
  for (const c of connections) {
    const pending = c.collect?.erasePending;
    if (!pending) continue;
    try {
      const r = await eraseConnectionData(ctx, c.id, pending, { by: "system", now: deps.now, db: deps.db, searchIndex: deps.searchIndex });
      if (r.search === "failed") console.warn(`[connectors] erase for ${c.id} couldn't remove its searches from brand search, tried again next run`);
      else erased += 1;
    } catch (err) {
      console.warn(`[connectors] erase for ${c.id} failed, tried again next run:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return { erased };
}
