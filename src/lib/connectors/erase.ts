import { changeDataConnection, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { CollectState, DataConnection } from "@/lib/types/dataConnection";
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
 * What goes: the connection's metric snapshots (every day, rolled and planning doc). Search
 * Console's brand search source, its data_signals rows, its open suggestions and the undecided
 * brand map questions it proposed join this list as brand search and signals land. Each erase
 * records one `erased` activity row, kept in the log only, never on the record's recent list.
 */

export interface EraseCounts {
  snapshots: number;
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
 * Erase a connection's collected rows: all of them, or the listed old generations. Then, in one
 * change, clear what is pending (only what this erase covered) and record one `erased` row (the
 * purge, which leaves its own "purged" row, records none). Safe to run again: a second run finds
 * nothing to delete.
 */
export async function eraseConnectionData(
  ctx: TenantContext,
  connectionId: string,
  gens: "all" | readonly number[],
  opts: { by: string; now?: Date; db?: FirestoreLike; record?: boolean },
): Promise<EraseCounts> {
  const snapshots = await eraseSnapshots(ctx, connectionId, gens, { db: opts.db });
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
  return { snapshots };
}

/**
 * The lane's housekeeping: erase what a connection still has pending, one connection at a time.
 * A failure is logged and left pending for the next run.
 */
export async function retryPendingErases(ctx: TenantContext, connections: readonly DataConnection[], deps: { db?: FirestoreLike; now?: Date } = {}): Promise<{ erased: number }> {
  let erased = 0;
  for (const c of connections) {
    const pending = c.collect?.erasePending;
    if (!pending) continue;
    try {
      await eraseConnectionData(ctx, c.id, pending, { by: "system", now: deps.now, db: deps.db });
      erased += 1;
    } catch (err) {
      console.warn(`[connectors] erase for ${c.id} failed, tried again next run:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return { erased };
}
