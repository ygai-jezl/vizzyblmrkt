import { countDataConnectionActivity, forTenant, OPERATOR_LABEL, purgeDataConnection, type PurgeCounts, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { DataConnection } from "@/lib/types/dataConnection";
import { isGoogleRevokeEnabled } from "./flags";
import { revokeGoogleToken, type GoogleDeps } from "./google";
import { REFRESH_SLOT } from "./tokenKeeper";
import { openConnectorSecret, VaultOpenError } from "./vault";

/**
 * The operator purge (scripts/connectors-purge.ts, ADR-0011): remove what YouGrow keeps for a
 * brand's connections, whatever any switch says. For one connection, or every connection of one
 * brand, it deletes the sealed secrets, the recent list and the activity rows, marks the
 * connection disconnected and leaves one "purged" row as the trace. A pasted token can't be
 * cancelled from here. A Google sign in is revoked at Google only with
 * CONNECTOR_GOOGLE_REVOKE_ENABLED on, after its purge, because Google's revoke ends every grant
 * that Google account gave this app, for every brand (Connectors 1c adds deleting a share access
 * address).
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
  /** What was removed, with apply, and whether a Google sign in was revoked at Google. */
  removed: Array<{ connectionId: string; revoked: boolean } & PurgeCounts>;
  /** The connection asked for, when this brand has none by that id. */
  missing: string | null;
}

/** "purge:<label>", for the activity row. The label is short: letters, digits, _ and -. */
export function purgeActor(label: string | undefined): string {
  if (!label || !OPERATOR_LABEL.test(label)) throw new Error("--by takes a short label: lower case letters, digits, _ and -, up to 40 characters, with no @ or dots");
  return `purge:${label}`;
}

/** Count, and with apply remove, one brand's connection data. */
/** A Google sign in's refresh token to revoke, when the switch is on and it opens here. */
function toRevoke(ctx: TenantContext, c: DataConnection): string | null {
  const sealed = c.secrets[REFRESH_SLOT];
  if (!isGoogleRevokeEnabled() || c.method !== "oauth_pkce" || !sealed) return null;
  try {
    return openConnectorSecret(ctx.tenantId, c.id, REFRESH_SLOT, sealed);
  } catch (err) {
    if (err instanceof VaultOpenError) return null;
    throw err;
  }
}

export async function purgeConnections(
  ctx: TenantContext,
  opts: { connectionId?: string; apply: boolean; by?: string; now?: Date; db?: FirestoreLike } & Pick<GoogleDeps, "transport" | "log">,
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
  for (const c of conns) {
    const signIn = toRevoke(ctx, c);
    const counts = await purgeDataConnection(ctx, c.id, by, at, opts.db);
    const revoked = signIn ? await revokeGoogleToken(signIn, { transport: opts.transport, log: opts.log }) : false;
    report.removed.push({ connectionId: c.id, ...counts, revoked });
  }
  return report;
}

/** The lines the script prints: ids and counts only. */
export function purgeLines(r: PurgeReport): string[] {
  const lines: string[] = [];
  if (r.missing) lines.push(`${r.tenantId}: no connection ${r.missing}`);
  for (const i of r.items) lines.push(`${r.tenantId}: ${i.connectionId} (${i.connectorId}, ${i.status}): ${i.secrets} secrets, ${i.recent} recent, ${i.activity} activity rows`);
  for (const x of r.removed) {
    lines.push(`${r.tenantId}: ${x.connectionId} purged: ${x.secretsDeleted} secrets, ${x.recentDeleted} recent, ${x.activityDeleted} activity rows removed${x.revoked ? ", sign in revoked at Google" : ""}`);
  }
  return lines;
}
