import { countDataConnectionActivity, forTenant, OPERATOR_LABEL, purgeDataConnection, type PurgeCounts, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";

/**
 * The operator purge (scripts/connectors-purge.ts, ADR-0011): remove what YouGrow keeps for a
 * brand's connections, whatever any switch says. For one connection, or every connection of one
 * brand, it deletes the sealed secrets, the recent list and the activity rows, marks the
 * connection disconnected and leaves one "purged" row as the trace. Nothing at the provider is
 * touched: a pasted token can't be cancelled from here (Connectors 1c adds deleting a share
 * access address).
 *
 * Turning CONNECTORS_ENABLED off is the rollback; this is how the data goes. The dry run counts
 * and writes nothing.
 */

export interface PurgeItem {
  connectionId: string;
  connectorId: string;
  status: string;
  secrets: number;
  recent: number;
  activity: number;
}

export interface PurgeReport {
  tenantId: string;
  apply: boolean;
  /** What each connection held before the purge. */
  items: PurgeItem[];
  /** What was removed, with apply. */
  removed: Array<{ connectionId: string } & PurgeCounts>;
  /** The connection asked for, when this brand has none by that id. */
  missing: string | null;
}

/** "purge:<label>", for the activity row. The label is short: letters, digits, _ and -. */
export function purgeActor(label: string | undefined): string {
  if (!label || !OPERATOR_LABEL.test(label)) throw new Error("--by takes a short label: lower case letters, digits, _ and -, up to 40 characters, with no @ or dots");
  return `purge:${label}`;
}

/** Count, and with apply remove, one brand's connection data. */
export async function purgeConnections(
  ctx: TenantContext,
  opts: { connectionId?: string; apply: boolean; by?: string; now?: Date; db?: FirestoreLike },
): Promise<PurgeReport> {
  const by = opts.apply ? purgeActor(opts.by) : "";
  const repo = forTenant(ctx, opts.db);
  let conns = opts.connectionId ? [await repo.dataConnections.getById(opts.connectionId)].filter((c): c is NonNullable<typeof c> => c !== null) : await repo.dataConnections.find();
  conns = conns.sort((a, b) => a.id.localeCompare(b.id));
  const report: PurgeReport = { tenantId: ctx.tenantId, apply: opts.apply, items: [], removed: [], missing: opts.connectionId && !conns.length ? opts.connectionId : null };
  for (const c of conns) {
    report.items.push({
      connectionId: c.id,
      connectorId: c.connectorId,
      status: c.status,
      secrets: Object.keys(c.secrets).length,
      recent: c.recent.length,
      activity: await countDataConnectionActivity(ctx, c.id, opts.db),
    });
  }
  if (!opts.apply) return report;
  const at = (opts.now ?? new Date()).toISOString();
  for (const c of conns) report.removed.push({ connectionId: c.id, ...(await purgeDataConnection(ctx, c.id, by, at, opts.db)) });
  return report;
}

/** The lines the script prints: ids and counts only. */
export function purgeLines(r: PurgeReport): string[] {
  const lines: string[] = [];
  if (r.missing) lines.push(`${r.tenantId}: no connection ${r.missing}`);
  for (const i of r.items) lines.push(`${r.tenantId}: ${i.connectionId} (${i.connectorId}, ${i.status}): ${i.secrets} secrets, ${i.recent} recent, ${i.activity} activity rows`);
  for (const x of r.removed) lines.push(`${r.tenantId}: ${x.connectionId} purged: ${x.secretsDeleted} secrets, ${x.recentDeleted} recent, ${x.activityDeleted} activity rows removed`);
  return lines;
}
