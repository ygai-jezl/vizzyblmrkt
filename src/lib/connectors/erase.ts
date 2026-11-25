import { clearSearchConsoleArticles, clearSearchConsoleDue } from "@/lib/content/blog/freshnessErase";
import { removeFromIndex } from "@/lib/search/indexer";
import type { SearchStore } from "@/lib/search/types";
import { changeDataConnection, forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { CollectState, DataConnection } from "@/lib/types/dataConnection";
import { searchTextRef } from "./keys";
import { searchConsoleManifest } from "./manifests/searchConsole";
import { blankDismissedFrom, declineAs, openSuggestionsOf, withdrawProposedBy } from "./signals/reconcile";
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
 * values cleared and the brand map questions they proposed that nobody has decided are withdrawn
 * (removed, not dismissed, so their words don't stay; decided ones stay, a person adopted them);
 * for a Search Console connection, the figures article freshness copied from its numbers (the
 * "losing clicks" and "within reach" reasons on the brand's due list and on every article, and
 * Next up picks that weighed Search Console; src/lib/content/blog/freshnessErase.ts); and a Search
 * Console connection's searches in brand search (ADR-0013), removed with indexing forced on, so they
 * leave whatever SEARCH_INDEX_ENABLED or CONNECTORS_SEARCH_TEXT_ENABLED says. A failed removal, or
 * an article step that failed or ran out of time, leaves the erase pending for the lane. Each erase
 * records one `erased` activity row, kept in the log only, never on the record's recent list.
 */

/** The brand's search index (tests pass an in-memory one); default searchStoreFor. */
export type SearchIndexOf = (ctx: Pick<TenantContext, "tenantId" | "region">) => SearchStore;

export interface EraseCounts {
  snapshots: number;
  /** Its data_signals rows deleted, its open suggestions declined as stale, and the undecided questions it proposed withdrawn. */
  signals: number;
  declined: number;
  withdrawn: number;
  /**
   * Its searches in brand search: removed (or none were there), failed (the erase stays pending),
   * or skipped for a connection that puts none there.
   */
  search: "removed" | "failed" | "skipped";
  /**
   * Search Console's figures in article freshness: taken out; not all yet (a step failed, it ran out
   * of time, or the searches couldn't be removed first), so the erase stays pending; or skipped for
   * a connection that puts none there.
   */
  freshness: "cleared" | "unfinished" | "skipped";
}

/**
 * Whether a connection may have put Search Console's numbers beyond its own snapshots and
 * suggestions: a Search Console one, or one that can't be read, which is treated as one so nothing
 * is left behind.
 */
async function maybeSearchConsole(ctx: TenantContext, connectionId: string, deps: { db?: FirestoreLike }): Promise<boolean> {
  const conn = await forTenant(ctx, deps.db)
    .dataConnections.getById(connectionId)
    .catch(() => null);
  return !conn || conn.connectorId === searchConsoleManifest.id;
}

/**
 * Remove a connection's searches from brand search, whatever any switch says. Only Search Console
 * connections put any there; one that can't be read is tried anyway (maybeSearchConsole).
 */
async function eraseSearchText(ctx: TenantContext, connectionId: string, searchConsole: boolean, deps: { searchIndex?: SearchIndexOf }): Promise<EraseCounts["search"]> {
  if (!searchConsole) return "skipped";
  const outcome = await removeFromIndex(ctx, "research", searchTextRef(connectionId), { force: true, ...(deps.searchIndex ? { store: deps.searchIndex(ctx) } : {}) });
  return outcome === "failed" ? "failed" : "removed";
}

/**
 * A connection's suggestions from collected numbers, whatever any switch says: every open one
 * declined as stale with its values cleared, then the rows deleted. For listed generations, only
 * theirs. The open ones are found from the agent actions (at most 15 open a brand, by equality),
 * whose proposal names the connection and generation, so none is missed however many rows the
 * connection holds; the rows' own actions are added for any older one.
 */
async function eraseSuggestions(
  ctx: TenantContext,
  connectionId: string,
  gens: "all" | readonly number[],
  deps: { db?: FirestoreLike; now?: Date },
): Promise<{ signals: number; declined: number; withdrawn: number }> {
  const rows = (await signalsOfConnection(ctx, connectionId, deps)).filter((r) => gens === "all" || gens.includes(r.gen));
  const open = await openSuggestionsOf(ctx, connectionId, gens, deps);
  let declined = 0;
  const seen = new Set<string>();
  for (const a of open) {
    seen.add(a.id);
    if (await declineAs(ctx, a, "stale", deps)) declined += 1;
  }
  for (const id of new Set(rows.map((r) => r.agentActionId))) {
    if (!isAgentActionId(id) || seen.has(id)) continue;
    const a = await getAgentAction(ctx, id, deps);
    if (a && (a.state === "proposed" || a.state === "approved") && (await declineAs(ctx, a, "stale", deps))) declined += 1;
  }
  const proposed = [...rows.filter((r) => r.shownIn === "brand_map" && r.questionId).map((r) => r.questionId!), ...open.filter((a) => a.target.type === "brand_question").map((a) => a.target.id)];
  const withdrawn = await withdrawProposedBy(ctx, connectionId, gens === "all" ? "all" : proposed, deps);
  // Dismissed ones keep their own words, so the search isn't proposed again, but not the search's.
  await blankDismissedFrom(ctx, connectionId, deps);
  const signals = await eraseSignals(ctx, connectionId, gens, deps);
  return { signals, declined, withdrawn };
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
 * in brand search and the figures article freshness copied from it either way (they are the old
 * site's after Change property; the new site's are indexed again once it has 28 days, and
 * freshness looks again at once). Then, in one change, clear what is pending (only what this
 * erase covered) and record one `erased` row (the purge, which leaves its own "purged" row, records
 * none). When the searches couldn't be removed, or the article step didn't finish, nothing is
 * cleared, so the lane tries again. Safe to run again: a second run finds nothing to delete.
 *
 * The article step reads every plan the brand has, so it stops at `deadlineMs` (the lane passes its
 * own; with none it takes FRESHNESS_CLEAR.BUDGET_MS) and runs only once the searches are removed, so
 * a removal that keeps failing never repeats it. With `lastTry` (the operator purge, which deletes
 * the record next, so nothing is tried again) it always runs, with no deadline.
 */
export async function eraseConnectionData(
  ctx: TenantContext,
  connectionId: string,
  gens: "all" | readonly number[],
  opts: { by: string; now?: Date; db?: FirestoreLike; record?: boolean; searchIndex?: SearchIndexOf; deadlineMs?: number; lastTry?: boolean },
): Promise<EraseCounts> {
  const searchConsole = await maybeSearchConsole(ctx, connectionId, opts);
  const snapshots = await eraseSnapshots(ctx, connectionId, gens, { db: opts.db });
  const { signals, declined, withdrawn } = await eraseSuggestions(ctx, connectionId, gens, { db: opts.db, now: opts.now });
  // The due list and Next up first (two documents), so Review, Next up and Vizzy stop at once.
  // Both steps never throw: a failure is logged there and keeps the erase pending here.
  const due = searchConsole ? await clearSearchConsoleDue(ctx, { db: opts.db, now: opts.now }) : null;
  const search = await eraseSearchText(ctx, connectionId, searchConsole, opts);
  const articles =
    searchConsole && (search !== "failed" || opts.lastTry)
      ? await clearSearchConsoleArticles(ctx, { db: opts.db, deadlineMs: opts.lastTry ? Number.POSITIVE_INFINITY : opts.deadlineMs })
      : null;
  const freshness: EraseCounts["freshness"] = !searchConsole ? "skipped" : due?.failed || !articles?.finished ? "unfinished" : "cleared";
  if (search === "failed" || freshness === "unfinished") return { snapshots, signals, declined, withdrawn, search, freshness };
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
  return { snapshots, signals, declined, withdrawn, search, freshness };
}

/**
 * The lane's housekeeping: erase what a connection still has pending, one connection at a time,
 * each article step stopping at the lane's deadline. A failure is logged and left pending for the
 * next run.
 */
export async function retryPendingErases(
  ctx: TenantContext,
  connections: readonly DataConnection[],
  deps: { db?: FirestoreLike; now?: Date; searchIndex?: SearchIndexOf; deadlineMs?: number } = {},
): Promise<{ erased: number }> {
  let erased = 0;
  for (const c of connections) {
    const pending = c.collect?.erasePending;
    if (!pending) continue;
    try {
      const r = await eraseConnectionData(ctx, c.id, pending, { by: "system", now: deps.now, db: deps.db, searchIndex: deps.searchIndex, deadlineMs: deps.deadlineMs });
      if (r.search === "failed") console.warn(`[connectors] erase for ${c.id} couldn't remove its searches from brand search, tried again next run`);
      else if (r.freshness === "unfinished") console.warn(`[connectors] erase for ${c.id} didn't finish taking Search Console figures out of article freshness, tried again next run`);
      else erased += 1;
    } catch (err) {
      console.warn(`[connectors] erase for ${c.id} failed, tried again next run:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return { erased };
}
