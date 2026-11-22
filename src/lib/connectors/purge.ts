import { countDataConnectionActivity, forTenant, OPERATOR_LABEL, purgeDataConnection, type PurgeCounts, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { DataConnection } from "@/lib/types/dataConnection";
import { isGoogleRevokeEnabled } from "./flags";
import { revokeGoogleToken, type GoogleDeps } from "./google";
import { deleteConnectionAddress } from "./service";
import { brandTag, copyTag, deleteShareAccount, identitiesProject, listShareAccounts, type ShareDeps } from "./shareAccess";
import { REFRESH_SLOT } from "./tokenKeeper";
import { openConnectorSecret, VaultOpenError } from "./vault";

/**
 * The operator purge (scripts/connectors-purge.ts, ADR-0011): remove what YouGrow keeps for a
 * brand's connections, whatever any switch says. For one connection, or every connection of one
 * brand, it deletes the sealed secrets, the recent list and the activity rows, marks the
 * connection disconnected and leaves one "purged" row as the trace. A pasted token can't be
 * cancelled from here. A Google sign in is revoked at Google only with
 * CONNECTOR_GOOGLE_REVOKE_ENABLED on, after its purge, because Google's revoke ends every grant
 * that Google account gave this app, for every brand.
 *
 * Share access (Connectors 1c): each connection's Google address is deleted at Google after its
 * purge, and a failed delete is recorded as cleanup_failed for the next run. With the identities
 * project set it also reconciles: it lists YouGrow's addresses there and deletes this brand's (on
 * this copy, by GOOGLE_CLOUD_PROJECT) that no live connection owns (left by a crash between making
 * an address and saving its connection, or by a delete that failed). `addressesOnly` does only
 * that and the disconnected connections' leftover addresses, leaving every record and its history
 * alone.
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
  /** A shared connection's Google address: still at Google, deleted already, or none. */
  address: "kept" | "deleted" | "none";
}

export interface PurgeReport {
  tenantId: string;
  apply: boolean;
  /** Only leftover Google addresses were looked at; no record was purged. */
  addressesOnly: boolean;
  /** What each connection held before the purge. */
  items: PurgeItem[];
  /**
   * What was removed, with apply: whether a Google sign in was revoked, and whether a shared
   * connection's Google address was deleted (null when it had none to delete).
   */
  removed: Array<{ connectionId: string; revoked: boolean; addressDeleted: boolean | null } & PurgeCounts>;
  /** This brand's Google addresses that no live connection owns; deleted is null in a dry run. */
  orphans: Array<{ email: string; connectionId: string; deleted: boolean | null }>;
  /** Why the identities project wasn't looked at, or null when it was. */
  shareSkipped: string | null;
  /** The connection asked for, when this brand has none by that id. */
  missing: string | null;
}

/** "purge:<label>", for the activity row. The label is short: letters, digits, _ and -. */
export function purgeActor(label: string | undefined): string {
  if (!label || !OPERATOR_LABEL.test(label)) throw new Error("--by takes a short label: lower case letters, digits, _ and -, up to 40 characters, with no @ or dots");
  return `purge:${label}`;
}

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

/** A shared connection's address that is still at Google, or null. */
function keptAddress(c: DataConnection) {
  return c.method === "share_access" && c.serviceAccount && !c.serviceAccount.deletedAt ? c.serviceAccount : null;
}

/**
 * This brand's addresses in the identities project that no live connection owns: tagged for this
 * brand and this copy, and naming a connection the brand doesn't have, or one whose address is
 * another or is marked deleted. With a connection named, only addresses naming it. An address
 * tagged for another copy, or for no copy, is never this copy's to delete: another copy sharing the
 * identities project has records this one can't see.
 */
async function findOrphans(
  ctx: TenantContext,
  conns: readonly DataConnection[],
  connectionId: string | undefined,
  deps: ShareDeps,
): Promise<{ project: string; orphans: Array<{ email: string; uniqueId: string; connectionId: string }> } | { skipped: string }> {
  const project = identitiesProject();
  if (!project) return { skipped: "CONNECTORS_IDENTITIES_PROJECT is not set, so no Google address was looked for" };
  const listed = await listShareAccounts(project, deps);
  if (!listed.ok) return { skipped: `listing the identities project failed (${listed.code})` };
  const tag = brandTag(ctx.tenantId);
  const copy = copyTag();
  const orphans: Array<{ email: string; uniqueId: string; connectionId: string }> = [];
  for (const a of listed.accounts) {
    if (!a.owner || a.owner.brand !== tag || a.owner.copy !== copy) continue;
    if (connectionId && a.owner.connectionId !== connectionId) continue;
    const owner = conns.find((c) => c.id === a.owner!.connectionId);
    const owns = owner?.serviceAccount && owner.serviceAccount.uniqueId === a.uniqueId && !owner.serviceAccount.deletedAt;
    if (!owns) orphans.push({ email: a.email, uniqueId: a.uniqueId, connectionId: a.owner.connectionId });
  }
  return { project, orphans };
}

/** Count, and with apply remove, one brand's connection data and its leftover Google addresses. */
export async function purgeConnections(
  ctx: TenantContext,
  opts: { connectionId?: string; apply: boolean; by?: string; now?: Date; db?: FirestoreLike; addressesOnly?: boolean } & Pick<GoogleDeps, "transport" | "log"> &
    Pick<ShareDeps, "appToken" | "sleep">,
): Promise<PurgeReport> {
  const by = opts.apply ? purgeActor(opts.by) : "";
  const addressesOnly = opts.addressesOnly === true;
  const share: ShareDeps = { transport: opts.transport, log: opts.log, appToken: opts.appToken, sleep: opts.sleep, now: opts.now };
  const repo = forTenant(ctx, opts.db);
  let conns = opts.connectionId ? [await repo.dataConnections.getById(opts.connectionId)].filter((c): c is NonNullable<typeof c> => c !== null) : await repo.dataConnections.find();
  conns = conns.sort((a, b) => a.id.localeCompare(b.id));
  const report: PurgeReport = {
    tenantId: ctx.tenantId,
    apply: opts.apply,
    addressesOnly,
    items: [],
    removed: [],
    orphans: [],
    shareSkipped: null,
    missing: opts.connectionId && !conns.length ? opts.connectionId : null,
  };
  // Addresses only: the disconnected connections whose address is still at Google.
  const targets = addressesOnly ? conns.filter((c) => c.status === "disconnected" && keptAddress(c)) : conns;
  for (const c of targets) {
    report.items.push({
      connectionId: c.id,
      connectorId: c.connectorId,
      status: c.status,
      secrets: Object.keys(c.secrets).length,
      recent: c.recent.length,
      activity: await countDataConnectionActivity(ctx, c.id, opts.db),
      address: c.serviceAccount ? (c.serviceAccount.deletedAt ? "deleted" : "kept") : "none",
    });
  }
  const found = await findOrphans(ctx, conns, opts.connectionId, share);
  if ("skipped" in found) report.shareSkipped = found.skipped;
  else report.orphans = found.orphans.map((o) => ({ email: o.email, connectionId: o.connectionId, deleted: null }));
  if (!opts.apply) return report;

  const at = (opts.now ?? new Date()).toISOString();
  for (const c of targets) {
    const sa = keptAddress(c);
    if (addressesOnly) {
      const deleted = await deleteConnectionAddress(ctx, c.id, sa!, by, { db: opts.db, ...share });
      report.removed.push({ connectionId: c.id, found: true, activityDeleted: 0, secretsDeleted: 0, recentDeleted: 0, revoked: false, addressDeleted: deleted });
      continue;
    }
    const signIn = toRevoke(ctx, c);
    const counts = await purgeDataConnection(ctx, c.id, by, at, opts.db);
    const revoked = signIn ? await revokeGoogleToken(signIn, { transport: opts.transport, log: opts.log }) : false;
    const addressDeleted = sa ? await deleteConnectionAddress(ctx, c.id, sa, by, { db: opts.db, ...share }) : null;
    report.removed.push({ connectionId: c.id, ...counts, revoked, addressDeleted });
  }
  if (!("skipped" in found)) {
    report.orphans = [];
    for (const o of found.orphans) {
      const r = await deleteShareAccount(found.project, o.uniqueId, share);
      report.orphans.push({ email: o.email, connectionId: o.connectionId, deleted: r.ok });
    }
  }
  return report;
}

const ADDRESS_WORDS = { kept: ", a Google address at Google", deleted: ", its Google address deleted", none: "" } as const;

/** The lines the script prints: ids, counts and YouGrow's own Google addresses, never a secret. */
export function purgeLines(r: PurgeReport): string[] {
  const lines: string[] = [];
  if (r.missing) lines.push(`${r.tenantId}: no connection ${r.missing}`);
  for (const i of r.items) {
    lines.push(`${r.tenantId}: ${i.connectionId} (${i.connectorId}, ${i.status}): ${i.secrets} secrets, ${i.recent} recent, ${i.activity} activity rows${ADDRESS_WORDS[i.address]}`);
  }
  for (const x of r.removed) {
    const address = x.addressDeleted === null ? "" : x.addressDeleted ? ", Google address deleted" : ", Google address NOT deleted (recorded as cleanup_failed; run again)";
    if (r.addressesOnly) lines.push(`${r.tenantId}: ${x.connectionId}${address}`);
    else lines.push(`${r.tenantId}: ${x.connectionId} purged: ${x.secretsDeleted} secrets, ${x.recentDeleted} recent, ${x.activityDeleted} activity rows removed${x.revoked ? ", sign in revoked at Google" : ""}${address}`);
  }
  for (const o of r.orphans) {
    const what = o.deleted === null ? "no live connection owns it" : o.deleted ? "deleted" : "NOT deleted; run again";
    lines.push(`${r.tenantId}: leftover Google address ${o.email} (for ${o.connectionId}): ${what}`);
  }
  if (r.shareSkipped) lines.push(`${r.tenantId}: ${r.shareSkipped}`);
  return lines;
}
